import {
  BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { hasAllPermissions } from '../../../common/auth/permission-check.util';
import { AdminUser, CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { PrismaService } from '../../../database/prisma.service';
import { buildAdminNotification } from '../../../infrastructure/admin-notifications/admin-notification.builder';
import { AdminNotificationDispatcher } from '../../../infrastructure/admin-notifications/admin-notification.dispatcher';
import { AdminNotificationMetrics } from '../../../infrastructure/admin-notifications/admin-notification.metrics';
import { AdminNotificationRepository } from '../../../infrastructure/admin-notifications/admin-notification.repository';
import { SseHubService } from '../../../infrastructure/admin-notifications/sse-hub.service';
import { BellListQueryDto, ManualNotificationDto, RegisterPushDto } from '../application/dto/bell-query.dto';

/** Claims carried by the admin access token (mirrors AdminJwtPayload). */
interface StreamTokenClaims {
  sub?: string;
  role?: string | null;
  permissions?: string[];
}

/**
 * Admin notification platform API: bell feed (cursor pagination), unread badge,
 * realtime SSE stream, read state, web-push token registry, manual broadcast.
 */
@ApiTags('admin-bell')
@Controller({ path: 'admin/notifications', version: '1' })
export class AdminBellController {
  // Standalone verifier (same secret + checks as the admin-jwt strategy).
  private readonly jwt = new JwtService({});

  constructor(
    private readonly repository: AdminNotificationRepository,
    private readonly dispatcher: AdminNotificationDispatcher,
    private readonly sseHub: SseHubService,
    private readonly metrics: AdminNotificationMetrics,
    private readonly prisma: PrismaService,
  ) {}

  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Notification.read')
  @Get()
  list(@CurrentAdmin() admin: AdminUser, @Query() query: BellListQueryDto) {
    return this.repository.list({
      adminId: admin.sub,
      cursor: query.cursor,
      limit: query.limit,
      unread: query.unread === true,
      category: query.category,
    });
  }

  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Notification.read')
  @Get('unread-count')
  async unreadCount(@CurrentAdmin() admin: AdminUser) {
    return { count: await this.repository.unreadCount(admin.sub) };
  }

  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Notification.read')
  @Get('metrics')
  observability() {
    return { ...this.metrics.snapshot(), activeSseConnections: this.sseHub.activeConnections() };
  }

  /**
   * SSE stream. EventSource cannot send Authorization headers, so the admin JWT
   * arrives as ?token= and is verified EXACTLY like the admin-jwt strategy
   * (same secret + active-admin check) before the connection is registered.
   */
  @Get('stream')
  async stream(@Req() req: Request, @Res() res: Response, @Query('token') token?: string) {
    const secret = process.env.JWT_ADMIN_ACCESS_SECRET;
    if (!token || !secret) throw new UnauthorizedException('Missing stream token');
    let claims: StreamTokenClaims;
    try {
      claims = this.jwt.verify<StreamTokenClaims>(token, { secret });
      if (!claims.sub) throw new Error('no sub');
    } catch {
      throw new UnauthorizedException('Invalid stream token');
    }
    // Same RBAC as every sibling endpoint (guards can't run here — the JWT rides
    // as a query param). Claims are the same source PermissionGuard reads.
    if (!hasAllPermissions(claims, ['Notification.read'])) {
      throw new UnauthorizedException('Missing Notification.read permission');
    }
    const admin = await this.prisma.admin.findFirst({ where: { id: claims.sub, isActive: true }, select: { id: true } });
    if (!admin) throw new UnauthorizedException('Admin account is no longer active');
    this.sseHub.register(claims.sub, res);
  }

  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Notification.read')
  @Patch('read-all')
  async readAll(@CurrentAdmin() admin: AdminUser) {
    const result = await this.repository.markAllRead(admin.sub);
    this.dispatcher.notifyRead(admin.sub, 'all'); // sync every open tab
    return result;
  }

  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Notification.read')
  @Patch(':id/read')
  async read(@Param('id') id: string, @CurrentAdmin() admin: AdminUser) {
    const result = await this.repository.markRead(id, admin.sub);
    this.dispatcher.notifyRead(admin.sub, id);
    return result;
  }

  // Manual broadcast to every active admin (announcements / ops notices).
  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Notification.manage')
  @Post('manual')
  async manual(@Body() dto: ManualNotificationDto, @CurrentAdmin() admin: AdminUser) {
    const draft = buildAdminNotification('manual.notification', { ...dto });
    if (!draft) throw new BadRequestException('Invalid manual notification');
    draft.metadata = { ...(draft.metadata ?? {}), sentBy: admin.sub };
    const created = await this.dispatcher.dispatch(draft);
    return { created };
  }
}

/** Web-push token registry (spec path: /admin/push/register). */
@ApiTags('admin-bell')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/push', version: '1' })
export class AdminPushController {
  constructor(private readonly repository: AdminNotificationRepository) {}

  @Permissions('Notification.read')
  @Post('register')
  register(@Body() dto: RegisterPushDto, @CurrentAdmin() admin: AdminUser, @Req() req: Request) {
    return this.repository.registerPushToken(admin.sub, { ...dto, userAgent: req.headers['user-agent'] as string | undefined });
  }

  @Permissions('Notification.read')
  @Delete('register/:token')
  unregister(@Param('token') token: string, @CurrentAdmin() admin: AdminUser) {
    return this.repository.removePushToken(admin.sub, token);
  }
}
