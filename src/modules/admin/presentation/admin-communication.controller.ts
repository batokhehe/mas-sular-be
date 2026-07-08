import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminUser, CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { CustomerCommunicationService } from '../customer-communication.service';
import { PreviewCommunicationDto, SendCommunicationDto } from '../application/dto/communication.dto';

/**
 * Customer Communication Center. Reads (`Notification.read`) join outbox rows to a
 * customer; preview/send (`Notification.send`) compose manual messages that are
 * QUEUED through the existing NotificationOutbox pipeline — never sent directly.
 */
@ApiTags('admin-customer-communication')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/system/communications', version: '1' })
export class AdminCommunicationController {
  constructor(private readonly communications: CustomerCommunicationService) {}

  // Customer search: name / phone / email / order number / notification id.
  @Permissions('Notification.read')
  @Get('search')
  search(@Query('q') q: string) {
    return this.communications.search(q ?? '');
  }

  // Conversation + profile + metrics for the customer behind one notification.
  @Permissions('Notification.read')
  @Get('by-notification/:id')
  byNotification(@Param('id') id: string) {
    return this.communications.byNotification(id);
  }

  @Permissions('Notification.read')
  @Get('customers/:userId')
  byCustomer(@Param('userId') userId: string) {
    return this.communications.byCustomer(userId);
  }

  // Render-only template preview (templates live in code; nothing is editable).
  @Permissions('Notification.send')
  @Post('preview')
  preview(@Body() dto: PreviewCommunicationDto) {
    return this.communications.preview(dto);
  }

  @Permissions('Notification.send')
  @Post('send')
  send(@CurrentAdmin() admin: AdminUser, @Body() dto: SendCommunicationDto) {
    return this.communications.send({ id: admin.sub, name: admin.name }, dto);
  }
}
