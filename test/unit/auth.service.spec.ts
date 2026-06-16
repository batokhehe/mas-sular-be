import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from '../../src/modules/auth/auth.service';

function buildPrismaMock() {
  return {
    role: { findUnique: jest.fn() },
    user: { upsert: jest.fn(), findFirst: jest.fn() },
    refreshToken: { create: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  };
}

function buildService(prisma: ReturnType<typeof buildPrismaMock>) {
  const jwt = { signAsync: jest.fn().mockResolvedValue('signed-access-token') };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AuthService(prisma as any, jwt as any);
  return { service, jwt };
}

const CUSTOMER_ROLE = { id: 'role-customer', name: 'CUSTOMER' };

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'active@example.com',
    isActive: true,
    deletedAt: null,
    roles: [{ role: CUSTOMER_ROLE }],
    addresses: [],
    ...overrides,
  };
}

describe('AuthService account-status enforcement', () => {
  const originalClientId = process.env.GOOGLE_CLIENT_ID;

  beforeAll(() => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  });

  afterAll(() => {
    process.env.GOOGLE_CLIENT_ID = originalClientId;
  });

  describe('issueTokens', () => {
    it('issues tokens for an active user', async () => {
      const prisma = buildPrismaMock();
      prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      prisma.refreshToken.create.mockResolvedValue({});
      const { service } = buildService(prisma);

      const tokens = await service.issueTokens('user-1', 'active@example.com', ['CUSTOMER']);

      expect(tokens.accessToken).toBe('signed-access-token');
      expect(typeof tokens.refreshToken).toBe('string');
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    });

    it('refuses to issue tokens for a disabled user', async () => {
      const prisma = buildPrismaMock();
      prisma.user.findFirst.mockResolvedValue(null); // not active / soft-deleted
      const { service } = buildService(prisma);

      await expect(
        service.issueTokens('user-1', 'disabled@example.com', ['CUSTOMER']),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('loginWithGoogleProfile', () => {
    const profile = {
      googleId: 'g-1',
      email: 'active@example.com',
      name: 'Active User',
    };

    it('logs in an active user and returns tokens', async () => {
      const prisma = buildPrismaMock();
      prisma.role.findUnique.mockResolvedValue(CUSTOMER_ROLE);
      prisma.user.upsert.mockResolvedValue(activeUser());
      prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      prisma.refreshToken.create.mockResolvedValue({});
      const { service } = buildService(prisma);

      const result = await service.loginWithGoogleProfile(profile);

      expect(result.user.id).toBe('user-1');
      expect(result.tokens.accessToken).toBe('signed-access-token');
    });

    it('rejects Google login for a deactivated user', async () => {
      const prisma = buildPrismaMock();
      prisma.role.findUnique.mockResolvedValue(CUSTOMER_ROLE);
      prisma.user.upsert.mockResolvedValue(activeUser({ isActive: false }));
      const { service } = buildService(prisma);

      await expect(service.loginWithGoogleProfile(profile)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      // never reaches token issuance
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects Google login for a soft-deleted user', async () => {
      const prisma = buildPrismaMock();
      prisma.role.findUnique.mockResolvedValue(CUSTOMER_ROLE);
      prisma.user.upsert.mockResolvedValue(activeUser({ deletedAt: new Date() }));
      const { service } = buildService(prisma);

      await expect(service.loginWithGoogleProfile(profile)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('rotateRefreshToken', () => {
    const presentedToken = 'opaque-refresh-token';

    function tokenRecord(userOverrides: Record<string, unknown> = {}) {
      return {
        id: 'rt-1',
        userId: 'user-1',
        tokenHash: bcrypt.hashSync(presentedToken, 4),
        user: {
          email: 'active@example.com',
          isActive: true,
          deletedAt: null,
          roles: [{ role: CUSTOMER_ROLE }],
          ...userOverrides,
        },
      };
    }

    it('rotates the token for an active user', async () => {
      const prisma = buildPrismaMock();
      prisma.refreshToken.findMany.mockResolvedValue([tokenRecord()]);
      prisma.refreshToken.update.mockResolvedValue({});
      prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      prisma.refreshToken.create.mockResolvedValue({});
      const { service } = buildService(prisma);

      const tokens = await service.rotateRefreshToken(presentedToken);

      expect(tokens.accessToken).toBe('signed-access-token');
      expect(prisma.refreshToken.update).toHaveBeenCalledTimes(1); // old token revoked
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1); // new token issued
    });

    it('rejects rotation for a disabled user and revokes the presented token', async () => {
      const prisma = buildPrismaMock();
      prisma.refreshToken.findMany.mockResolvedValue([tokenRecord({ isActive: false })]);
      prisma.refreshToken.update.mockResolvedValue({});
      const { service } = buildService(prisma);

      await expect(service.rotateRefreshToken(presentedToken)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.update).toHaveBeenCalledTimes(1); // token still revoked
      expect(prisma.refreshToken.create).not.toHaveBeenCalled(); // no new token
    });

    it('rejects an unknown refresh token', async () => {
      const prisma = buildPrismaMock();
      prisma.refreshToken.findMany.mockResolvedValue([tokenRecord()]);
      const { service } = buildService(prisma);

      await expect(service.rotateRefreshToken('wrong-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
    });
  });
});
