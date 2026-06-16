import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { StringValue } from 'ms';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const admin = await this.prisma.admin.findUnique({
      where: { email },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(password, admin.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const firstRoleRel = admin.roles[0];
    const roleName = firstRoleRel?.role?.name || null;
    const roleObj = firstRoleRel
      ? {
          id: firstRoleRel.role.id,
          name: firstRoleRel.role.name === 'SUPER_ADMIN' ? 'Super Admin' : firstRoleRel.role.name,
        }
      : null;

    const permissions = await this.getAdminPermissions(admin.id, roleName);

    const accessToken = await this.issueAccessToken(
      admin.id,
      admin.email,
      admin.name,
      admin.isActive,
      roleName,
      permissions,
    );
    const refreshToken = await this.issueRefreshToken(admin.id, admin.email);

    return {
      accessToken,
      refreshToken,
      user: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: roleObj,
      },
      permissions,
    };
  }

  async getAdminPermissions(adminId: string, roleName?: string | null): Promise<string[]> {
    if (roleName === 'SUPER_ADMIN' || roleName === 'Super Admin') {
      const allPerms = await this.prisma.permission.findMany();
      return allPerms.map((p) => `${p.subject}.${p.action}`);
    }
    const adminRoles = await this.prisma.adminRole.findMany({
      where: { adminId },
      include: {
        role: {
          include: {
            permissions: {
              include: {
                permission: true,
              },
            },
          },
        },
      },
    });
    const perms = new Set<string>();
    for (const ar of adminRoles) {
      if (ar.role.name === 'SUPER_ADMIN' || ar.role.name === 'Super Admin') {
        const allPerms = await this.prisma.permission.findMany();
        return allPerms.map((p) => `${p.subject}.${p.action}`);
      }
      for (const rp of ar.role.permissions) {
        perms.add(`${rp.permission.subject}.${rp.permission.action}`);
      }
    }
    return Array.from(perms);
  }

  async issueAccessToken(
    id: string,
    email: string,
    name: string,
    isActive: boolean,
    role?: string | null,
    permissions?: string[],
  ) {
    const expiresIn = (process.env.JWT_ADMIN_ACCESS_TTL ?? '1d') as StringValue;
    return this.jwt.signAsync(
      { sub: id, email, name, isActive, role, permissions },
      { expiresIn },
    );
  }

  async issueRefreshToken(id: string, email: string) {
    return this.jwt.signAsync(
      { sub: id, email, type: 'refresh' },
      { expiresIn: '7d' },
    );
  }
}
