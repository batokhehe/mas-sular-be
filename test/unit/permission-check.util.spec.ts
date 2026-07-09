import { expandPermissionAliases, hasAllPermissions, isSuperAdmin } from '../../src/common/auth/permission-check.util';

describe('permission-check.util (shared by PermissionGuard and the SSE stream)', () => {
  it('SUPER_ADMIN bypasses every check (both role spellings)', () => {
    expect(isSuperAdmin({ role: 'SUPER_ADMIN' })).toBe(true);
    expect(isSuperAdmin({ role: 'Super Admin' })).toBe(true);
    expect(isSuperAdmin({ role: 'OPS' })).toBe(false);
    expect(hasAllPermissions({ role: 'SUPER_ADMIN', permissions: [] }, ['Notification.read'])).toBe(true);
  });

  it('grants when every required permission is held', () => {
    const user = { role: 'OPS', permissions: ['Notification.read', 'SystemLog.read'] };
    expect(hasAllPermissions(user, ['Notification.read'])).toBe(true);
    expect(hasAllPermissions(user, ['Notification.read', 'SystemLog.read'])).toBe(true);
    expect(hasAllPermissions(user, ['Notification.read', 'Audit.read'])).toBe(false);
  });

  it('accepts the legacy subjects.action alias (read → view)', () => {
    expect(expandPermissionAliases('Notification.read')).toEqual(['Notification.read', 'notifications.view']);
    expect(expandPermissionAliases('Queue.retry')).toEqual(['Queue.retry', 'queues.retry']);
    expect(hasAllPermissions({ permissions: ['notifications.view'] }, ['Notification.read'])).toBe(true);
  });

  it('denies with no permissions; empty requirement always passes', () => {
    expect(hasAllPermissions({}, ['Notification.read'])).toBe(false);
    expect(hasAllPermissions({ permissions: undefined }, ['Notification.read'])).toBe(false);
    expect(hasAllPermissions({}, [])).toBe(true);
  });
});
