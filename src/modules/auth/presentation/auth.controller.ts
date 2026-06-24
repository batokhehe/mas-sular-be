import { Body, Controller, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from '../auth.service';
import { GoogleLoginDto, RefreshTokenDto } from '../application/dto/auth.dto';
import {
  AUTH_COOKIES,
  clearCustomerAuthCookies,
  clearCustomerSessionMarker,
  setCustomerAuthCookies,
  setCustomerSessionMarker,
} from '../../../common/auth/auth-cookies.util';

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Phase 13A.2: additionally sets httpOnly ms_access/ms_refresh cookies.
  // The response body is identical to before ({ user, tokens }).
  @Post('google')
  async google(@Body() dto: GoogleLoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.loginWithGoogleIdToken(dto.idToken);
    setCustomerAuthCookies(res, result.tokens);
    setCustomerSessionMarker(res); // Phase 13A.7: JS-readable presence marker (no token)
    return result;
  }

  // Phase 13A.2: refresh token resolved cookie-first, then body (backward compatible).
  // Rotation logic, token generation, and the { accessToken, refreshToken } body are unchanged;
  // the rotated pair is additionally written to ms_access/ms_refresh.
  @Post('refresh')
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.[AUTH_COOKIES.refresh] ?? dto.refreshToken;
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }
    const tokens = await this.auth.rotateRefreshToken(refreshToken);
    setCustomerAuthCookies(res, tokens);
    return tokens;
  }

  // Phase 13A.3: idempotent logout. Resolves the refresh token cookie-first (body
  // fallback for mobile), best-effort revokes only that token, and ALWAYS clears
  // the auth cookies — even when no token is present.
  @Post('logout')
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.[AUTH_COOKIES.refresh] ?? dto.refreshToken;
    if (refreshToken) {
      await this.auth.revokeRefreshToken(refreshToken).catch(() => undefined);
    }
    clearCustomerAuthCookies(res);
    clearCustomerSessionMarker(res); // Phase 13A.7
    return { success: true };
  }
}
