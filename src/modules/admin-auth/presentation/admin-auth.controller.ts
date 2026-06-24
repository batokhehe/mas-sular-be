import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AdminAuthService } from '../admin-auth.service';
import { AdminLoginDto } from '../application/dto/admin-auth.dto';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { CurrentAdmin, AdminUser } from '../../../common/decorators/current-admin.decorator';
import {
  clearAdminAuthCookies,
  clearAdminSessionMarker,
  setAdminAuthCookies,
  setAdminSessionMarker,
} from '../../../common/auth/auth-cookies.util';

@ApiTags('admin-auth')
@Controller({ path: 'admin/auth', version: '1' })
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  // Phase 13A.5: additionally sets the httpOnly ms_admin_access cookie (access token
  // only — no refresh cookie). The response body is unchanged ({ accessToken,
  // refreshToken, user, permissions }) so the Bearer-based frontend keeps working.
  @Post('login')
  async login(@Body() dto: AdminLoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto.email, dto.password);
    setAdminAuthCookies(res, { accessToken: result.accessToken });
    setAdminSessionMarker(res); // Phase 13A.7: JS-readable presence marker (no token)
    return result;
  }

  @UseGuards(AdminGuard)
  @Get('me')
  me(@CurrentAdmin() admin: AdminUser) {
    return {
      id: admin.sub,
      email: admin.email,
      name: admin.name,
      isActive: admin.isActive,
      permissions: admin.permissions,
    };
  }

  // Phase 13A.5: clears ms_admin_access. No token revocation (the admin access
  // token is stateless) — clearing is the cookie equivalent of dropping the Bearer.
  @UseGuards(AdminGuard)
  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    clearAdminAuthCookies(res);
    clearAdminSessionMarker(res); // Phase 13A.7
    return { success: true };
  }
}
