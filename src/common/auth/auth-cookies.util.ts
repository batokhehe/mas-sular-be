/**
 * Phase 13A.1 — httpOnly auth cookie utility.
 *
 * Reusable set/clear helpers for the three httpOnly auth cookies. Standalone —
 * NOT consumed by any controller yet (wired in 13A.2 customer / 13A.5 admin).
 * No session-marker cookies (ms_session / ms_admin_session) are issued: they
 * only benefit the frontend (Phase 13B), so they are omitted from Phase 13A.
 */
import type { CookieOptions, Request, Response } from 'express';
import type { JwtFromRequestFunction } from 'passport-jwt';
import { CookieConfig, loadCookieConfig } from './auth-cookies.config';

/** httpOnly auth cookie names. */
export const AUTH_COOKIES = {
  access: 'ms_access',
  refresh: 'ms_refresh',
  adminAccess: 'ms_admin_access',
} as const;

/**
 * Phase 13A.7 — JS-readable session-presence markers (NOT httpOnly, value "true").
 * They carry NO token and NO user data; their only purpose is to let the SPA
 * detect "is there a session" once the real tokens become httpOnly (Phase 13B).
 */
export const SESSION_COOKIES = {
  customer: 'ms_session',
  admin: 'ms_admin_session',
} as const;

/** Literal marker value — deliberately opaque, never a token. */
const SESSION_MARKER_VALUE = 'true';

// The refresh cookie is scoped (config.authCookiePath, derived from
// API_PREFIX/API_VERSION) so the browser only sends it to the auth routes.
const ROOT_PATH = '/';

function setOptions(config: CookieConfig, maxAgeMs: number, path: string): CookieOptions {
  return {
    httpOnly: true,
    secure: config.secure,
    sameSite: config.sameSite,
    domain: config.domain,
    path,
    maxAge: maxAgeMs,
  };
}

// Clearing requires the SAME attributes (domain/path/sameSite/secure) as setting.
function clearOptions(config: CookieConfig, path: string): CookieOptions {
  return {
    httpOnly: true,
    secure: config.secure,
    sameSite: config.sameSite,
    domain: config.domain,
    path,
  };
}

export function setCustomerAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
  config: CookieConfig = loadCookieConfig(),
): void {
  res.cookie(AUTH_COOKIES.access, tokens.accessToken, setOptions(config, config.accessMaxAgeMs, ROOT_PATH));
  res.cookie(AUTH_COOKIES.refresh, tokens.refreshToken, setOptions(config, config.refreshMaxAgeMs, config.authCookiePath));
}

export function clearCustomerAuthCookies(res: Response, config: CookieConfig = loadCookieConfig()): void {
  res.clearCookie(AUTH_COOKIES.access, clearOptions(config, ROOT_PATH));
  res.clearCookie(AUTH_COOKIES.refresh, clearOptions(config, config.authCookiePath));
}

export function setAdminAuthCookies(
  res: Response,
  tokens: { accessToken: string },
  config: CookieConfig = loadCookieConfig(),
): void {
  res.cookie(AUTH_COOKIES.adminAccess, tokens.accessToken, setOptions(config, config.adminAccessMaxAgeMs, ROOT_PATH));
}

export function clearAdminAuthCookies(res: Response, config: CookieConfig = loadCookieConfig()): void {
  res.clearCookie(AUTH_COOKIES.adminAccess, clearOptions(config, ROOT_PATH));
}

// Marker cookies mirror the token cookies' domain/secure/sameSite (so they travel
// the same way) but are explicitly NON-httpOnly so client JS can read presence.
function markerSetOptions(config: CookieConfig, maxAgeMs: number): CookieOptions {
  return {
    httpOnly: false,
    secure: config.secure,
    sameSite: config.sameSite,
    domain: config.domain,
    path: ROOT_PATH,
    maxAge: maxAgeMs,
  };
}

function markerClearOptions(config: CookieConfig): CookieOptions {
  return {
    httpOnly: false,
    secure: config.secure,
    sameSite: config.sameSite,
    domain: config.domain,
    path: ROOT_PATH,
  };
}

/** Phase 13A.7 — set ms_session="true" (lifetime mirrors the refresh window). */
export function setCustomerSessionMarker(res: Response, config: CookieConfig = loadCookieConfig()): void {
  res.cookie(SESSION_COOKIES.customer, SESSION_MARKER_VALUE, markerSetOptions(config, config.refreshMaxAgeMs));
}

export function clearCustomerSessionMarker(res: Response, config: CookieConfig = loadCookieConfig()): void {
  res.clearCookie(SESSION_COOKIES.customer, markerClearOptions(config));
}

/** Phase 13A.7 — set ms_admin_session="true" (lifetime mirrors the admin access window). */
export function setAdminSessionMarker(res: Response, config: CookieConfig = loadCookieConfig()): void {
  res.cookie(SESSION_COOKIES.admin, SESSION_MARKER_VALUE, markerSetOptions(config, config.adminAccessMaxAgeMs));
}

export function clearAdminSessionMarker(res: Response, config: CookieConfig = loadCookieConfig()): void {
  res.clearCookie(SESSION_COOKIES.admin, markerClearOptions(config));
}

/**
 * Phase 13A.4 — passport-jwt cookie extractors (used AFTER the Bearer extractor).
 *
 * Fail-safe by contract:
 *  - returns null when AUTH_COOKIE_EXTRACTOR_ENABLED is not "true" (rollback),
 *  - returns null when the cookie is absent / not a non-empty string,
 *  - never throws (any error → null so the chain stays Bearer-only).
 * Returning null lets ExtractJwt.fromExtractors fall through to the next extractor.
 */
function readAuthCookie(req: Request | undefined, cookieName: string): string | null {
  try {
    const config = loadCookieConfig();
    if (!config.authCookieExtractorEnabled) return null;
    const value = req?.cookies?.[cookieName];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Extracts the customer access JWT from the httpOnly `ms_access` cookie. */
export const customerCookieExtractor: JwtFromRequestFunction = (req) =>
  readAuthCookie(req as Request | undefined, AUTH_COOKIES.access);

/** Extracts the admin access JWT from the httpOnly `ms_admin_access` cookie. */
export const adminCookieExtractor: JwtFromRequestFunction = (req) =>
  readAuthCookie(req as Request | undefined, AUTH_COOKIES.adminAccess);
