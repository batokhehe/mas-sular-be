import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../database/prisma.service';
import { customerCookieExtractor } from '../../../common/auth/auth-cookies.util';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const secret = config.get<string>('jwt.accessSecret');
    if (!secret) {
      throw new Error('JWT_ACCESS_SECRET is not configured'); // no insecure fallback
    }
    super({
      // Phase 13A.4: Bearer FIRST (unchanged behavior for header clients/mobile),
      // then the httpOnly ms_access cookie (gated by AUTH_COOKIE_EXTRACTOR_ENABLED).
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        customerCookieExtractor,
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: { sub: string; email: string; roles: string[] }) {
    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!user) {
      throw new UnauthorizedException('Account is no longer active');
    }
    return payload;
  }
}
