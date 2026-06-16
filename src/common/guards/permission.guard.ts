import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { AdminUser } from '../decorators/current-admin.decorator';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AdminUser }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Insufficient permissions');
    }

    if (this.isSuperAdmin(user)) {
      return true;
    }

    const userPermissions = new Set(user.permissions ?? []);
    const hasAllPermissions = requiredPermissions.every((permission) => {
      const acceptedPermissions = this.expandPermissionAliases(permission);
      return acceptedPermissions.some((acceptedPermission) =>
        userPermissions.has(acceptedPermission),
      );
    });

    if (!hasAllPermissions) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }

  private isSuperAdmin(user: AdminUser): boolean {
    return user.role === 'SUPER_ADMIN' || user.role === 'Super Admin';
  }

  private expandPermissionAliases(permission: string): string[] {
    const aliases = new Set([permission]);
    const [subject, action] = permission.split('.');

    if (subject && action) {
      const legacySubject = `${subject.charAt(0).toLowerCase()}${subject.slice(1)}s`;
      const legacyAction = action === 'read' ? 'view' : action;
      aliases.add(`${legacySubject}.${legacyAction}`);
    }

    return Array.from(aliases);
  }
}
