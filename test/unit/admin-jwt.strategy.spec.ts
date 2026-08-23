import { UnauthorizedException } from '@nestjs/common';
import { AdminJwtStrategy } from '../../src/modules/admin-auth/infrastructure/admin-jwt.strategy';

/**
 * Regression for C7a.
 *
 * Authorization used to run off the JWT: PermissionGuard read `payload.permissions`
 * and isSuperAdmin() read `payload.role`. With JWT_ADMIN_ACCESS_TTL at its default of
 * 1d, a revoked permission, a removed role, or a demoted SUPER_ADMIN changed nothing
 * for up to 24 hours on a token already in circulation.
 *
 * These tests pin the property that fixes it: whatever the token claims, `validate()`
 * returns the role and permissions the DATABASE holds right now. Every case therefore
 * hands in a token whose claims disagree with the rows.
 */

const SECRET = 'unit-test-admin-secret-not-a-real-key';

/** Rows shaped exactly as the join returns them: one per granted permission. */
function rows(over: { roleName?: string | null; perms?: Array<[string, string]> } = {}) {
  const roleName = over.roleName === undefined ? 'ADMIN' : over.roleName;
  const perms = over.perms ?? [['Role', 'read']];
  const base = { id: 'adm-1', email: 'admin@test.local', name: 'Test Admin', roleName };
  if (perms.length === 0) {
    return [{ ...base, subject: null, action: null }];
  }
  return perms.map(([subject, action]) => ({ ...base, subject, action }));
}

function build(queryResult: unknown[]) {
  const queryRaw = jest.fn().mockResolvedValue(queryResult);
  const prisma = { $queryRaw: queryRaw };
  const config = { get: jest.fn().mockReturnValue(SECRET) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const strategy = new AdminJwtStrategy(config as any, prisma as any);
  return { strategy, queryRaw };
}

/** A token whose claims are deliberately wrong, to prove they are never the authority. */
const STALE_TOKEN = {
  sub: 'adm-1',
  email: 'stale@test.local',
  name: 'Stale Name',
  isActive: true,
  role: 'SUPER_ADMIN',
  permissions: ['Payment.verify', 'Role.update', 'Product.delete'],
};

describe('AdminJwtStrategy.validate — the database is the authority (C7a)', () => {
  it('1. returns the permissions the DB holds for an active admin', async () => {
    const { strategy } = build(rows({ perms: [['Role', 'read'], ['Order', 'read']] }));
    const user = await strategy.validate({ ...STALE_TOKEN, role: 'ADMIN', permissions: [] });
    expect(user.permissions.sort()).toEqual(['Order.read', 'Role.read']);
    expect(user.isActive).toBe(true);
  });

  it('2. a permission present in the token but absent from the DB is NOT returned', async () => {
    const { strategy } = build(rows({ perms: [['Role', 'read']] }));
    const user = await strategy.validate(STALE_TOKEN);
    expect(user.permissions).toEqual(['Role.read']);
    for (const stale of STALE_TOKEN.permissions) {
      expect(user.permissions).not.toContain(stale);
    }
  });

  it('3. a stale SUPER_ADMIN claim does not survive: role comes from the DB', async () => {
    const { strategy } = build(rows({ roleName: 'ADMIN', perms: [['Role', 'read']] }));
    const user = await strategy.validate(STALE_TOKEN); // token says SUPER_ADMIN
    expect(user.role).toBe('ADMIN');
    // hasAllPermissions() short-circuits on role === SUPER_ADMIN; that bypass is gone.
    expect(user.role).not.toBe('SUPER_ADMIN');
  });

  it('4. an admin whose role was removed gets no role and no permissions', async () => {
    const { strategy } = build(rows({ roleName: null, perms: [] }));
    const user = await strategy.validate(STALE_TOKEN);
    expect(user.role).toBeNull();
    expect(user.permissions).toEqual([]);
  });

  it('5. edited role permissions are reflected immediately', async () => {
    const { strategy } = build(rows({ perms: [['Product', 'update']] }));
    const user = await strategy.validate({ ...STALE_TOKEN, permissions: ['Role.read'] });
    expect(user.permissions).toEqual(['Product.update']);
    expect(user.permissions).not.toContain('Role.read');
  });

  it('6. an inactive admin is rejected exactly as before (query filters isActive)', async () => {
    const { strategy, queryRaw } = build([]); // the WHERE clause excluded the row
    await expect(strategy.validate(STALE_TOKEN)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(strategy.validate(STALE_TOKEN)).rejects.toThrow('Admin account is no longer active');
    expect(queryRaw).toHaveBeenCalled();
  });

  it('7. identity fields come from the DB row, not the token', async () => {
    const { strategy } = build(rows());
    const user = await strategy.validate(STALE_TOKEN);
    expect(user.sub).toBe('adm-1');
    expect(user.email).toBe('admin@test.local'); // token said stale@test.local
    expect(user.name).toBe('Test Admin'); // token said Stale Name
  });

  it('8. SUPER_ADMIN in the DB is honoured, and duplicate grants are de-duplicated', async () => {
    const { strategy } = build(
      rows({ roleName: 'SUPER_ADMIN', perms: [['Role', 'read'], ['Role', 'read'], ['Payment', 'verify']] }),
    );
    const user = await strategy.validate({ ...STALE_TOKEN, role: 'ADMIN' });
    expect(user.role).toBe('SUPER_ADMIN');
    expect(user.permissions.sort()).toEqual(['Payment.verify', 'Role.read']);
  });

  it('9. SUPER_ADMIN wins when the admin holds several roles', async () => {
    const { strategy } = build([
      { id: 'adm-1', email: 'a@t', name: 'A', roleName: 'STAFF', subject: 'Order', action: 'read' },
      { id: 'adm-1', email: 'a@t', name: 'A', roleName: 'SUPER_ADMIN', subject: 'Payment', action: 'verify' },
    ]);
    const user = await strategy.validate({ ...STALE_TOKEN, role: null });
    expect(user.role).toBe('SUPER_ADMIN');
  });

  it('10. exactly ONE database round-trip per request', async () => {
    const { strategy, queryRaw } = build(rows());
    await strategy.validate(STALE_TOKEN);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('11. the admin id is bound as a parameter, never interpolated into SQL', async () => {
    const { strategy, queryRaw } = build(rows());
    await strategy.validate({ ...STALE_TOKEN, sub: "adm-1' OR '1'='1" });
    const sql = queryRaw.mock.calls[0][0];
    // Prisma.sql keeps values in `values`; the text carries placeholders only.
    expect(sql.values).toContain("adm-1' OR '1'='1");
    expect(String(sql.strings ? sql.strings.join('') : sql)).not.toContain("OR '1'='1");
  });
});
