import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Prisma } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../database/prisma.service';
import { adminCookieExtractor } from '../../../common/auth/auth-cookies.util';

const SUPER_ADMIN = 'SUPER_ADMIN';

interface AdminJwtPayload {
  sub: string;
  email: string;
  name: string;
  isActive: boolean;
  role?: string | null;
  permissions?: string[];
}

/** One row per granted permission; a single all-NULL row when the admin has no role. */
interface AdminAuthRow {
  id: string;
  email: string;
  name: string;
  roleName: string | null;
  subject: string | null;
  action: string | null;
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

  /**
   * Resolves the admin's CURRENT role and permissions from the database (C7a).
   *
   * The token still carries `role` and `permissions`, because the login response and
   * the admin UI read them — but they are identity/UI payload only, never authority.
   * They used to be exactly that: PermissionGuard read `payload.permissions`, and
   * `isSuperAdmin()` read `payload.role`, so with JWT_ADMIN_ACCESS_TTL at its default
   * of 1d, revoking a permission, removing a role, or demoting a SUPER_ADMIN changed
   * nothing for up to 24 hours on a token already in circulation. Proven at runtime:
   * deleting the RolePermission row, then the AdminRole row, then demoting a super
   * admin to a permission-less role all left the same token answering 200. Only
   * isActive was ever re-checked, which made full deactivation the sole working lever.
   *
   * Everything downstream is untouched: `request.user` keeps its shape, so
   * PermissionGuard, hasAllPermissions() and every @Permissions() decorator work as
   * before - they simply now read live state. /admin/auth/me returns this same object,
   * so the admin UI picks up revocations with no frontend change.
   *
   * ONE round-trip. The audit measured Prisma's relation-include form at four extra
   * queries per request (AdminRole, Role, RolePermission, Permission - one per relation
   * level); this joins them instead. Every hop is index-served: AdminRole
   * PRIMARY(adminId, roleId), RolePermission PRIMARY(roleId, permissionId), Permission
   * PRIMARY(id). Parameterised via Prisma.sql - `payload.sub` is attacker-controlled
   * (it comes out of a token) and is bound, never interpolated.
   *
   * The SUPER_ADMIN arm of the join mirrors AdminAuthService.getAdminPermissions:
   * a super admin holds every Permission row. That expansion has to stay - the admin
   * UI gates purely on this flat list and never checks the role, so dropping it would
   * blank out a super admin's controls even though the server still authorised them.
   */
  async validate(payload: AdminJwtPayload) {
    const rows = await this.prisma.$queryRaw<AdminAuthRow[]>(Prisma.sql`
      SELECT a.id            AS id,
             a.email         AS email,
             a.name          AS name,
             r.name          AS roleName,
             p.subject       AS subject,
             p.action        AS action
      FROM \`Admin\` a
      LEFT JOIN \`AdminRole\` ar ON ar.adminId = a.id
      LEFT JOIN \`Role\` r ON r.id = ar.roleId
      LEFT JOIN \`Permission\` p
        ON r.name = ${SUPER_ADMIN}
        OR p.id IN (SELECT rp.permissionId FROM \`RolePermission\` rp WHERE rp.roleId = r.id)
      WHERE a.id = ${payload.sub} AND a.isActive = true
    `);

    // Unchanged rejection: no row means no such admin, or isActive is false.
    if (rows.length === 0) {
      throw new UnauthorizedException('Admin account is no longer active');
    }

    const roleNames = rows.map((row) => row.roleName).filter((name): name is string => !!name);
    // An admin may hold several roles. SUPER_ADMIN wins, matching getAdminPermissions,
    // which grants the full permission set when ANY of the admin's roles is super.
    const role = roleNames.find((name) => name === SUPER_ADMIN) ?? roleNames[0] ?? null;

    const permissions = new Set<string>();
    for (const row of rows) {
      if (row.subject && row.action) {
        permissions.add(`${row.subject}.${row.action}`);
      }
    }

    return {
      sub: rows[0].id,
      email: rows[0].email,
      name: rows[0].name,
      isActive: true, // the query filtered on it, so reaching here means active
      role,
      permissions: Array.from(permissions),
    };
  }
}
