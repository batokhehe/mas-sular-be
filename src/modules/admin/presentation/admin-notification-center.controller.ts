import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { NotificationCenterService } from '../../../infrastructure/lifecycle/notification-center.service';
import { ListNotificationCenterQueryDto } from '../application/dto/notification-center-query.dto';

/**
 * Notification Center. Reads gated by `Notification.read`; the only write is a
 * manual resend (`Notification.resend`) that delegates to the existing redrive
 * flow (FAILED → PENDING; the sender worker re-delivers).
 */
@ApiTags('admin-notification-center')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/system/notifications', version: '1' })
export class AdminNotificationCenterController {
  constructor(private readonly notifications: NotificationCenterService) {}

  // Paginated list + the 30s-cached overview in ONE response (single page load).
  @Permissions('Notification.read')
  @Get()
  async list(@Query() query: ListNotificationCenterQueryDto) {
    const [list, overview] = await Promise.all([
      this.notifications.list(query),
      this.notifications.overview(),
    ]);
    return { ...list, overview };
  }

  @Permissions('Notification.read')
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.notifications.detail(id);
  }

  @Permissions('Notification.resend')
  @Post(':id/resend')
  resend(@Param('id') id: string) {
    return this.notifications.resend(id);
  }
}
