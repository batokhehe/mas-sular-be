import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../database/prisma.service';
import { adminCookieExtractor } from '../../../common/auth/auth-cookies.util';

interface AdminJwtPayload {
  sub: string;
  email: string;
  name: string;
  isActive: boolean;
  role?: string | null;
  permissions?: string[];
}

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const secret = config.get<string>('jwt.adminAccessSecret');
    if (!secret) {
      throw new Error('JWT_ADMIN_ACCESS_SECRET is not configured'); // no insecure fallback
    }
    super({
      // Phase 13A.4: Bearer FIRST (unchanged behavior for header clients/mobile),
      // then the httpOnly ms_admin_access cookie (gated by AUTH_COOKIE_EXTRACTOR_ENABLED).
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        adminCookieExtractor,
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: AdminJwtPayload) {
    const admin = await this.prisma.admin.findFirst({
      where: { id: payload.sub, isActive: true },
      select: { id: true },
    });
    if (!admin) {
      throw new UnauthorizedException('Admin account is no longer active');
    }
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      isActive: payload.isActive,
      role: payload.role ?? null,
      permissions: payload.permissions ?? [],
    };
  }
}
