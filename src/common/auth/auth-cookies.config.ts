/**
 * Phase 13A.1 — httpOnly auth cookie configuration (env-driven).
 *
 * This file is a standalone loader (no Nest DI, mirrors loadOutboxConfig). It is
 * NOT wired into any controller/strategy yet — it only provides the cookie
 * options consumed by the cookie utility in later 13A sub-phases.
 */

export type SameSite = 'lax' | 'strict' | 'none';
export type CsrfMode = 'off' | 'report' | 'enforce';

export interface CookieConfig {
  /** Parent domain for first-party cookies, e.g. ".baksomassular.com". Undefined → host-only (dev). */
  domain?: string;
  secure: boolean;
  sameSite: SameSite;
  /**
   * Path the refresh cookie is scoped to, derived from API_PREFIX/API_VERSION so
   * it always matches the real /auth route base (never hardcoded).
   */
  authCookiePath: string;
  /** Cookie max-age (ms), derived from the existing JWT TTL envs. */
  accessMaxAgeMs: number;
  refreshMaxAgeMs: number;
  adminAccessMaxAgeMs: number;
  /**
   * Phase 13A.4 feature flag (AUTH_COOKIE_EXTRACTOR_ENABLED). When false (default)
   * the JWT cookie extractors return null, so auth is Bearer-only — identical to
   * pre-13A.4 production. Provides instant rollback via env without a redeploy.
   */
  authCookieExtractorEnabled: boolean;
  /**
   * Phase 13A.6 CSRF rollout mode (CSRF_MODE). off (default) → no validation,
   * report → validate + log but never block, enforce → 403 on mismatch/missing.
   * Stateless: governs the double-submit guard only; no persistence.
   */
  csrfMode: CsrfMode;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse a JWT-style TTL string ("1d", "30d", "3600s", "15m"...) into ms. */
function ttlToMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!match) return fallbackMs;
  const n = Number(match[1]);
  const unit = match[2];
  const mult =
    unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? DAY_MS : 1;
  return n > 0 ? n * mult : fallbackMs;
}

export function loadCookieConfig(env: NodeJS.ProcessEnv = process.env): CookieConfig {
  const sameSite = (env.COOKIE_SAMESITE as SameSite) ?? 'lax';
  const secureEnv = env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production';

  // Mirror main.ts: setGlobalPrefix(API_PREFIX ?? 'api') + URI versioning (v{API_VERSION ?? '1'}).
  const prefix = (env.API_PREFIX ?? 'api').replace(/^\/+|\/+$/g, '');
  const version = env.API_VERSION ?? '1';

  return {
    domain: env.COOKIE_DOMAIN || undefined,
    // SameSite=None is only valid alongside Secure (browser requirement); force it.
    secure: sameSite === 'none' ? true : secureEnv,
    sameSite,
    authCookiePath: `/${prefix}/v${version}/auth`,
    accessMaxAgeMs: ttlToMs(env.JWT_ACCESS_TTL, DAY_MS),
    refreshMaxAgeMs: ttlToMs(env.JWT_REFRESH_TTL, 30 * DAY_MS),
    adminAccessMaxAgeMs: ttlToMs(env.JWT_ADMIN_ACCESS_TTL, DAY_MS),
    authCookieExtractorEnabled: env.AUTH_COOKIE_EXTRACTOR_ENABLED === 'true',
    csrfMode: (env.CSRF_MODE as CsrfMode) ?? 'off',
  };
}
