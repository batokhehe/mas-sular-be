# syntax=docker/dockerfile:1.7
#
# Mas Sular API — production image.
#
# Four stages so the runtime carries ONLY what it needs: production
# dependencies, the generated Prisma Client, the compiled dist, and the schema.
# No devDependencies, no TypeScript sources, no .env.
#
# Entrypoint note: `nest build` emits dist/src/main.js for this project (the
# compilation root spans more than src/), which is what package.json `start`
# runs. An earlier image ran dist/main.js and could never boot.

ARG NODE_IMAGE=node:22.20.0-alpine3.21
ARG PNPM_VERSION=10.0.0

# ------------------------------------------------------------------ base ----
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ------------------------------------------------------- build dependencies -
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-be,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ------------------------------------------------------------------ build ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# prisma generate BEFORE nest build: the client is imported by compiled code.
RUN pnpm prisma:generate && pnpm build
# The entrypoint path is asserted at BUILD time. `nest build` emits
# dist/src/main.js here; a previous image shipped dist/main.js and could never
# start. Never let that class of mistake reach a container again.
RUN test -f dist/src/main.js \
    || { echo "ERROR: entrypoint not at dist/src/main.js"; \
         find dist -maxdepth 2 -name main.js; exit 1; }

# ------------------------------------------------- production dependencies --
# Pruned FROM the build stage rather than installed fresh, because pnpm stores
# the generated Prisma Client inside a peer-hashed virtual-store directory
# (node_modules/.pnpm/@prisma+client@X_prisma@X_typescript@X/...). A separate
# --prod install resolves a DIFFERENT hash, so the generated client could not be
# copied across reliably. Pruning keeps the client exactly where @prisma/client
# already resolves it, and still drops devDependencies:
#   558M -> 378M, top-level modules 39 -> 24, typescript/prisma/jest unreachable.
FROM build AS prod-deps
RUN pnpm prune --prod

# --------------------------------------------------------------- migrator ---
# One-shot image for `prisma migrate deploy`. Kept separate so the long-running
# API image never ships the Prisma CLI (a devDependency) or the ability to run
# migrations on its own. Compose runs this to completion BEFORE the API starts.
FROM base AS migrator
ENV NODE_ENV=production
# FROM build, not deps: pnpm 10 does not run postinstall scripts by default, so
# `@prisma/engines` never fetches its binaries during install. The build stage's
# `prisma generate` is what pulls them down (query engine AND schema-engine —
# the latter is what `migrate deploy` executes). Copying from deps left the
# migrator trying to download binaries.prisma.sh at runtime, on a network with
# no egress.
# --chown because this stage drops to the unprivileged `node` user.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node package.json ./
# F59 (Option A): the CMD below invokes `node` against the vendored Prisma CLI
# directly, so no package manager is on the command path. pnpm is present only
# because this stage inherits `base` (which runs corepack prepare); strip it and
# the rest so a compromised migrator cannot fetch or execute remote packages.
# The Prisma CLI, schema engine and @prisma/client all live under
# /app/node_modules and are untouched.
RUN rm -rf /pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* /sbin/apk /etc/apk /lib/apk /usr/share/apk /var/cache/apk
USER node
# Invoke the vendored Prisma CLI DIRECTLY. Going through `pnpm` makes corepack
# try to fetch the package manager from registry.npmjs.org at runtime, which
# fails by design here: this service sits on the `internal` network, which has
# no egress. Calling node against the local build needs no network at all.
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

# ----------------------------------------------------------------- runner ---
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    PORT=3001
# dumb-init is PID 1 so SIGTERM reaches Node and Nest's enableShutdownHooks()
# can drain the outbox relay and consumers instead of being killed mid-flight.
RUN apk add --no-cache dumb-init
WORKDIR /app

# The node:alpine image already provides an unprivileged `node` user (uid 1000).
# Production-only tree, with the generated Prisma Client already inside it.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --chown=node:node package.json ./

# Receipt uploads live here (main.ts serves join(process.cwd(), 'uploads')).
# Created up front so the volume mount inherits the right owner.
RUN mkdir -p /app/uploads && chown node:node /app/uploads

# F59 (Option A): strip package managers from the RUNTIME image. Nothing here
# invokes them — the app is `node dist/src/main.js` and the healthcheck is
# `node -e fetch(...)` — but `npx <anything>` is the most convenient way to run
# arbitrary remote code after an RCE, and this service has egress via `edge`.
# Safe because they are self-contained symlink targets: node is a standalone
# binary at /usr/local/bin/node and is untouched.
# NOT removed: sh/busybox (CMD-SHELL healthchecks and docker exec depend on it),
# dumb-init, node. BusyBox therefore still exposes wget/nc as applets — accepted
# residual risk; removing the /usr/bin/wget symlink would be cosmetic only.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* /sbin/apk /etc/apk /lib/apk /usr/share/apk /var/cache/apk

USER node
EXPOSE 3001

# Liveness only — /health is static. Readiness (which touches MySQL/Redis/
# RabbitMQ) is deliberately NOT used here: a transient broker blip should not
# make Docker restart a healthy API. Compose depends on this for ordering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/main.js"]
