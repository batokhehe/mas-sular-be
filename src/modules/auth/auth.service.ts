import { Injectable, UnauthorizedException, Logger, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { StringValue } from 'ms';
import { randomUUID } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');
  private readonly googleClient: OAuth2Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {
    this.logger.log('[AUTH] Initializing AuthService...');
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      this.logger.error('[AUTH] GOOGLE_CLIENT_ID is not configured!');
      throw new Error('GOOGLE_CLIENT_ID environment variable is required');
    }
    this.logger.debug(`[AUTH] GOOGLE_CLIENT_ID configured: ${clientId.substring(0, 20)}...`);
    this.googleClient = new OAuth2Client(clientId);
  }

  async loginWithGoogleIdToken(idToken: string) {
    this.logger.log('[GOOGLE AUTH REQUEST] Received Google ID token');
    this.logger.debug(`[GOOGLE AUTH REQUEST] Token length: ${idToken.length}`);

    try {
      this.logger.log('[GOOGLE TOKEN VERIFY] Starting token verification...');
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        this.logger.error('[GOOGLE TOKEN VERIFY] GOOGLE_CLIENT_ID not configured');
        throw new BadRequestException('Google client ID not configured');
      }
      
      this.logger.debug(`[GOOGLE TOKEN VERIFY] Using audience: ${clientId}`);
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: clientId,
      });
      
      this.logger.log('[GOOGLE TOKEN VERIFY] Token verification successful');
      const payload = ticket.getPayload();
      this.logger.debug(`[GOOGLE PAYLOAD] Email: ${payload?.email}, Sub: ${payload?.sub}, Name: ${payload?.name}`);
      
      if (!payload?.email || !payload.sub || !payload.name) {
        this.logger.error(`[GOOGLE PAYLOAD] Invalid payload - email: ${!!payload?.email}, sub: ${!!payload?.sub}, name: ${!!payload?.name}`);
        throw new UnauthorizedException('Invalid Google profile - missing required fields');
      }
      
      return this.loginWithGoogleProfile({
        googleId: payload.sub,
        email: payload.email,
        name: payload.name,
        avatarUrl: payload.picture,
      });
    } catch (error) {
      this.logger.error(`[GOOGLE AUTH REQUEST] Error: ${error instanceof Error ? error.message : String(error)}`);
      this.logger.error(`[GOOGLE AUTH REQUEST] Stack: ${error instanceof Error ? error.stack : ''}`);
      throw error;
    }
  }

  async loginWithGoogleProfile(profile: { googleId: string; email: string; name: string; avatarUrl?: string }) {
    this.logger.log(`[USER LOOKUP] Looking up user by email: ${profile.email}`);
    
    try {
      // First verify CUSTOMER role exists
      this.logger.log('[ROLE LOOKUP] Looking for CUSTOMER role...');
      const customerRole = await this.prisma.role.findUnique({ where: { name: 'CUSTOMER' } });
      
      if (!customerRole) {
        this.logger.error('[ROLE LOOKUP] CUSTOMER role not found in database!');
        throw new BadRequestException('CUSTOMER role does not exist in database');
      }
      
      this.logger.log(`[ROLE LOOKUP] CUSTOMER role found: ${customerRole.id}`);
      
      this.logger.log(`[USER CREATE] Upserting user with email ${profile.email}`);
      const user = await this.prisma.user.upsert({
        where: { email: profile.email },
        update: {
          googleId: profile.googleId,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
        },
        create: {
          googleId: profile.googleId,
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
          roles: { create: { roleId: customerRole.id } },
        },
        include: { roles: { include: { role: true } }, addresses: true },
      });
      
      this.logger.log(`[USER CREATE] User created/updated: ${user.id}`);
      this.logger.debug(`[USER CREATE] User roles: ${user.roles.map((r) => r.role.name).join(', ')}`);

      if (!user.isActive || user.deletedAt) {
        this.logger.warn(`[ACCOUNT STATUS] Rejecting Google login for disabled user ${user.id}`);
        throw new UnauthorizedException('Account is disabled');
      }

      this.logger.log('[TOKEN GENERATION] Generating tokens...');
      const tokens = await this.issueTokens(user.id, user.email, user.roles.map((r) => r.role.name));
      this.logger.log(`[TOKEN GENERATION] Tokens generated successfully`);
      
      return { user, tokens };
    } catch (error) {
      this.logger.error(`[USER CREATE] Error: ${error instanceof Error ? error.message : String(error)}`);
      this.logger.error(`[USER CREATE] Stack: ${error instanceof Error ? error.stack : ''}`);
      throw error;
    }
  }

  async issueTokens(userId: string, email: string, roles: string[]) {
    this.logger.log(`[TOKEN GENERATION] Creating tokens for user ${userId}`);
    try {
      const activeAccount = await this.prisma.user.findFirst({
        where: { id: userId, isActive: true, deletedAt: null },
        select: { id: true },
      });
      if (!activeAccount) {
        this.logger.warn(`[ACCOUNT STATUS] Refusing to issue tokens for disabled user ${userId}`);
        throw new UnauthorizedException('Account is disabled');
      }

      const familyId = randomUUID();
      const expiresIn = (process.env.JWT_ACCESS_TTL ?? '15m') as StringValue;
      this.logger.debug(`[TOKEN GENERATION] Access token TTL: ${expiresIn}`);
      
      this.logger.log('[TOKEN GENERATION] Signing access token...');
      const accessToken = await this.jwt.signAsync(
        { sub: userId, email, roles },
        { expiresIn },
      );
      this.logger.log('[TOKEN GENERATION] Access token signed');
      
      this.logger.log('[TOKEN GENERATION] Creating refresh token...');
      const refreshToken = randomUUID();
      await this.prisma.refreshToken.create({
        data: {
          userId,
          familyId,
          tokenHash: await bcrypt.hash(refreshToken, 12),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
      this.logger.log('[TOKEN GENERATION] Refresh token created in database');
      
      return { accessToken, refreshToken };
    } catch (error) {
      this.logger.error(`[TOKEN GENERATION] Error: ${error instanceof Error ? error.message : String(error)}`);
      this.logger.error(`[TOKEN GENERATION] Stack: ${error instanceof Error ? error.stack : ''}`);
      throw error;
    }
  }

  async rotateRefreshToken(refreshToken: string) {
    const candidates = await this.prisma.refreshToken.findMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
      include: { user: { include: { roles: { include: { role: true } } } } },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });
    const record = candidates.find((token) => bcrypt.compareSync(refreshToken, token.tokenHash));
    if (!record) throw new UnauthorizedException('Invalid refresh token');
    await this.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    if (!record.user.isActive || record.user.deletedAt) {
      this.logger.warn(`[ACCOUNT STATUS] Refusing refresh rotation for disabled user ${record.userId}`);
      throw new UnauthorizedException('Account is disabled');
    }
    return this.issueTokens(record.userId, record.user.email, record.user.roles.map((r) => r.role.name));
  }

  /**
   * Phase 13A.3 — revoke ONLY the presented refresh token record (used by logout).
   * Idempotent: a missing or already-revoked token is a silent no-op. Does not
   * rotate or issue tokens; familyId is not a lineage here, so there is no
   * family-wide revoke.
   */
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    const candidates = await this.prisma.refreshToken.findMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });
    const record = candidates.find((token) => bcrypt.compareSync(refreshToken, token.tokenHash));
    if (!record) return; // missing or already revoked → no-op
    await this.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  }
}
