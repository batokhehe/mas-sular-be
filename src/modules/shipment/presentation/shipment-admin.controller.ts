import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { PrepareShipmentDto } from '../application/dto/prepare-shipment.dto';
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

  /**
   * Admin packing action: book one or more orders with a pickup slot the
   * operator selected.
   *
   * Each order is reported individually and a failure never fails its
   * neighbours — a batch of ten where one product is unmeasured must book the
   * other nine and say precisely which one did not, rather than reporting a
   * blanket success or rolling everything back.
   */
  @Permissions('Shipment.create')
  @Post('shipments/prepare')
  async prepare(@Body() dto: PrepareShipmentDto) {
    const results = [];
    for (const orderId of dto.orderIds) {
      try {
        const outcome = await this.shipments.prepareForOrder(orderId, {
          pickupAtIso: dto.pickupAt,
          service: dto.service,
        });
        results.push({
          orderId,
          ok: outcome.ok,
          status: outcome.status,
          trackingNumber: outcome.trackingNumber ?? null,
          error: outcome.error ?? null,
        });
      } catch (error) {
        results.push({
          orderId,
          ok: false,
          status: null,
          trackingNumber: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results, booked: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }
}
