/**
 * Pure permission predicate shared by PermissionGuard and endpoints that must
 * authorize outside the guard pipeline (e.g. the SSE stream, where the JWT rides
 * as a query param). Single source of truth for the SUPER_ADMIN bypass and the
 * legacy `subjects.action` alias expansion.
 */

export interface PermissionSubject {
  role?: string | null;
  permissions?: string[];
}

export function isSuperAdmin(user: PermissionSubject): boolean {
  return user.role === 'SUPER_ADMIN' || user.role === 'Super Admin';
}

/** `Order.read` also accepts the legacy `orders.view` style grant. */
export function expandPermissionAliases(permission: string): string[] {
  const aliases = new Set([permission]);
  const [subject, action] = permission.split('.');

  if (subject && action) {
    const legacySubject = `${subject.charAt(0).toLowerCase()}${subject.slice(1)}s`;
    const legacyAction = action === 'read' ? 'view' : action;
    aliases.add(`${legacySubject}.${legacyAction}`);
  }

  return Array.from(aliases);
}

/** True when the user is SUPER_ADMIN or holds every required permission (aliases accepted). */
export function hasAllPermissions(user: PermissionSubject, required: string[]): boolean {
  if (required.length === 0) return true;
  if (isSuperAdmin(user)) return true;

  const granted = new Set(user.permissions ?? []);
  return required.every((permission) =>
    expandPermissionAliases(permission).some((accepted) => granted.has(accepted)),
  );
}
