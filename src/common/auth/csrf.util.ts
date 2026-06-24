/**
 * Phase 13A.6 — stateless double-submit CSRF helpers.
 *
 * No persistence of any kind: the token lives ONLY in the browser's XSRF-TOKEN
 * cookie and is validated purely by comparing that cookie to the X-CSRF-Token
 * header. No database, Redis, memory, or session store is involved.
 */
import { randomBytes, timingSafeEqual } from 'crypto';

/** The (JS-readable) double-submit cookie and its companion request header. */
export const XSRF_COOKIE = 'XSRF-TOKEN';
export const XSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** GET/HEAD/OPTIONS never change state → always bypass CSRF. */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/** 256-bit cryptographically-random token. Generated fresh, never stored server-side. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time equality; false on absence or length mismatch (timingSafeEqual throws on unequal length). */
export function constantTimeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

// Auth-bootstrap + anonymous upload routes are exempt. Matched on the path SUFFIX
// so they hold regardless of the configurable API prefix/version (e.g. /api/v1).
const EXEMPT_PATTERNS: readonly RegExp[] = [
  /\/auth\/google$/, // POST /auth/google — establishes the session
  /\/auth\/refresh$/, // POST /auth/refresh — gated by the refresh cookie/body
  /\/admin\/auth\/login$/, // POST /admin/auth/login — establishes the session
  /\/payments\/upload\/[^/]+\/file$/, // anonymous, token-gated receipt upload
];

/** True when the request path is one of the always-exempt CSRF bootstrap/upload routes. */
export function isExemptPath(path: string): boolean {
  return EXEMPT_PATTERNS.some((re) => re.test(path));
}
