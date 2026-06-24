/**
 * Phase 13A.6 — stateless double-submit CSRF guard.
 *
 * Registered globally (main.ts) ALONGSIDE the existing ThrottlerGuard — it does
 * not replace it. Pure function of the incoming request (method + path + auth
 * mode + XSRF cookie/header); holds no server-side state, so CSRF_MODE=off makes
 * it an instant no-op with nothing to drain or migrate.
 *
 * Enforcement is auth-aware: Bearer-authenticated requests (mobile, Postman,
 * integrations, the current frontend) bypass CSRF entirely; only requests that
 * authenticate via the httpOnly auth cookie are subject to the double-submit check.
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { loadCookieConfig } from './auth-cookies.config';
import { AUTH_COOKIES } from './auth-cookies.util';
import {
  XSRF_COOKIE,
  XSRF_HEADER,
  constantTimeEqual,
  generateCsrfToken,
  isExemptPath,
  isSafeMethod,
} from './csrf.util';

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly logger = new Logger('CsrfGuard');

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const config = loadCookieConfig();

    // (1) Seed the XSRF cookie when absent — and ONLY then (never rotate per request).
    //     Happens in every mode, including off, so the SPA can always read a token.
    if (!req.cookies?.[XSRF_COOKIE]) {
      res.cookie(XSRF_COOKIE, generateCsrfToken(), {
        httpOnly: false,
        secure: config.secure,
        sameSite: config.sameSite,
        domain: config.domain,
        path: '/',
      });
    }

    // (2) off → never validate.
    if (config.csrfMode === 'off') return true;

    // (3) Safe methods bypass.
    if (isSafeMethod(req.method)) return true;

    // (4) Exempt bootstrap/upload routes bypass.
    if (isExemptPath(req.path)) return true;

    // (5) Bearer-authenticated requests bypass — they are not cookie-auth and
    //     cannot be forged cross-site (header is not an ambient credential).
    const authz = req.headers.authorization;
    if (authz?.startsWith('Bearer ')) return true;

    // (6) Only cookie-authenticated requests are CSRF-vulnerable. No auth cookie
    //     present → not cookie-authenticated → nothing to protect.
    const cookieAuthed = Boolean(
      req.cookies?.[AUTH_COOKIES.access] || req.cookies?.[AUTH_COOKIES.adminAccess],
    );
    if (!cookieAuthed) return true;

    // (7) Double-submit: cookie token must equal header token (constant-time).
    const cookieToken = req.cookies?.[XSRF_COOKIE] as string | undefined;
    const headerToken = req.header(XSRF_HEADER);
    if (constantTimeEqual(cookieToken, headerToken)) return true;

    const reason = cookieToken ? 'token mismatch' : 'missing XSRF cookie';
    if (config.csrfMode === 'report') {
      this.logger.warn(
        `[CSRF report] would block ${req.method} ${req.path} — ${reason}; header ${headerToken ? 'present' : 'absent'}`,
      );
      return true; // report never blocks
    }

    // enforce
    this.logger.warn(`[CSRF enforce] blocked ${req.method} ${req.path} — ${reason}`);
    throw new ForbiddenException('Invalid CSRF token');
  }
}
