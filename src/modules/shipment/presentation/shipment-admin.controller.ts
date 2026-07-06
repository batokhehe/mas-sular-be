import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { ShipmentService } from '../shipment.service';

@ApiTags('admin-shipment')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/orders', version: '1' })
export class ShipmentAdminController {
  constructor(private readonly shipments: ShipmentService) {}

  /** Retry shipment creation for an order whose shipment is FAILED. */
  @Permissions('Shipment.create')
  @Post(':orderId/shipment/retry')
  retry(@Param('orderId') orderId: string) {
    return this.shipments.retry(orderId);
  }
}
