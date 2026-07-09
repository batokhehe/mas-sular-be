import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { QueueCenterService } from '../../../infrastructure/lifecycle/queue-center.service';
import { ListOutboxQueryDto, ListQueueNotificationsQueryDto, RetryAllFailedDto } from '../application/dto/queue-center-query.dto';

/**
 * Queue & Messaging Center. Reads are gated by `Queue.read`; the only writes are
 * manual retries (`Queue.retry`) that delegate to the existing RedriveService
 * (FAILED → PENDING reset). No business flow is touched.
 */
@ApiTags('admin-queue-center')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/system/queues', version: '1' })
export class AdminQueueController {
  constructor(private readonly queues: QueueCenterService) {}

  // Aggregated overview (summary, outbox, notifications, rabbitmq, deadLetters, workers).
  @Permissions('Queue.read')
  @Get()
  overview() {
    return this.queues.overview();
  }

  @Permissions('Queue.read')
  @Get('outbox')
  listOutbox(@Query() query: ListOutboxQueryDto) {
    return this.queues.listOutbox(query);
  }

  @Permissions('Queue.read')
  @Get('notifications')
  listNotifications(@Query() query: ListQueueNotificationsQueryDto) {
    return this.queues.listNotifications(query);
  }

  @Permissions('Queue.retry')
  @Post('outbox/:id/retry')
  retryOutbox(@Param('id') id: string) {
    return this.queues.retryOutbox(id);
  }

  @Permissions('Queue.retry')
  @Post('notifications/:id/retry')
  retryNotification(@Param('id') id: string) {
    return this.queues.retryNotification(id);
  }

  @Permissions('Queue.retry')
  @Post('retry-all-failed')
  retryAllFailed(@Body() dto: RetryAllFailedDto) {
    return this.queues.retryAllFailed(dto.target ?? 'all');
  }
}
