# Configuration & Startup Validation (Phase 8D)

All environment variables are validated at startup by
[`src/common/config/env.validation.ts`](src/common/config/env.validation.ts), wired
into `ConfigModule.forRoot({ validate: validateEnv })`. **Invalid configuration
fails fast** — the app refuses to boot and prints every problem at once.

## Configuration matrix

| Variable | Required | Validation | Notes |
|---|---|---|---|
| `NODE_ENV` | optional (default `development`) | `development\|test\|staging\|production` | gates CORS requirement |
| `DATABASE_URL` | **always** | non-empty | MySQL connection |
| `REDIS_URL` | **always** | non-empty | cache + queue |
| `JWT_ACCESS_SECRET` | **always** | ≥32 chars, not a known dev secret | no fallback |
| `JWT_REFRESH_SECRET` | **always** | ≥32 chars | |
| `JWT_ADMIN_ACCESS_SECRET` | **always** | ≥32 chars | |
| `GOOGLE_CLIENT_ID` | **always** | non-empty | customer login |
| `APP_URL` | **always** | valid URL | receipt `/uploads/<file>` base |
| `PAYMENT_UPLOAD_BASE_URL` | optional | valid URL if set | emailed link base |
| `CORS_ORIGINS` | **staging/prod** | non-empty, no `*` | explicit allowlist |
| `COOKIE_SECRET` | optional (recommended) | — | cookie signing |
| `OUTBOX_RELAY_ENABLED` / `CONSUMERS_ENABLED` | optional (default `false`) | `true\|false` | |
| `RABBITMQ_URL` | **when relay or consumers on** | required conditionally | else boot fails |
| `NOTIFICATION_SENDER_ENABLED` | optional (default `false`) | `true\|false` | |
| `RESEND_API_KEY` / `EMAIL_FROM` | **when sender on** | required conditionally | |
| `ADMIN_NOTIFICATION_EMAIL` | optional | valid email if set | receipt-uploaded alert |
| `PAYMENT_LIFECYCLE_ENABLED` | optional (default `false`) | `true\|false` | |
| `PAYMENT_FIRST/SECOND_REMINDER_MS`, `PAYMENT_EXPIRY_MS` | optional | positive ints, `FIRST < SECOND < EXPIRY` | |
| `PAYMENT_GATEWAY_EXPIRY_MS` | optional | non-negative int (`0`=never) | |
| `CHECKOUT_IDEMPOTENCY_ENABLED/REQUIRED` | optional (default `false`) | `REQUIRED` needs `ENABLED` | |
| `RETENTION_*`, `OUTBOX_*`, `NOTIFICATION_SENDER_*`, `CONSUMER_*` | optional | safe defaults | tuning knobs |

**Required (all envs):** `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `JWT_ADMIN_ACCESS_SECRET`, `GOOGLE_CLIENT_ID`, `APP_URL`.
**Additionally required outside local:** `CORS_ORIGINS`.
**Conditionally required:** `RABBITMQ_URL`, `RESEND_API_KEY`, `EMAIL_FROM`.

## Examples

**Local:** `NODE_ENV=development`, core + secrets + `GOOGLE_CLIENT_ID` + `APP_URL`,
async pipeline off, `CORS_ORIGINS` optional.

**Staging:** `NODE_ENV=staging` (or `production`), `CORS_ORIGINS=https://staging.app`,
enable the async stack (`OUTBOX_RELAY_ENABLED`, `CONSUMERS_ENABLED`,
`NOTIFICATION_SENDER_ENABLED` + `RABBITMQ_URL` + `RESEND_API_KEY` + `EMAIL_FROM` +
`ADMIN_NOTIFICATION_EMAIL`), `CHECKOUT_IDEMPOTENCY_ENABLED=true`,
`PAYMENT_UPLOAD_BASE_URL` set.

**Production:** staging + unique 32+ char secrets, `CHECKOUT_IDEMPOTENCY_REQUIRED=true`,
`PAYMENT_LIFECYCLE_ENABLED=true`, `RETENTION_ENABLED=true`. Confirm
`GET /health/ready` returns `rabbitmq: ok`.

## Startup validation behavior
- Aggregated fail-fast (all issues reported) before the app listens.
- JWT strategies throw if their secret is missing (no insecure fallback).
- CORS uses an explicit allowlist only — no reflect-all, no `*` with credentials.
- `GET /health/ready` returns `not_ready` if MySQL/Redis fail, or if RabbitMQ is
  required (relay/consumers on) but unset/unreachable.

## Remaining configuration risks
- Async features remain **opt-in**; a minimal deploy has no events/emails unless enabled.
- `CHECKOUT_IDEMPOTENCY_ENABLED` defaults `false` — set `true` (and eventually
  `REQUIRED=true`) to protect checkout from duplicate submits.
- `COOKIE_SECRET` is not yet enforced (recommended in staging/prod).
