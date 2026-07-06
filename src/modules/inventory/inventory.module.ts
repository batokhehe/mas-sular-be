import { Global, Module } from '@nestjs/common';
import { ShippingModule } from '../shipping/shipping.module';
import { DeliveryCoverageModule } from '../delivery-coverage/delivery-coverage.module';
import { INVENTORY_RESERVATION_CONFIG, loadInventoryReservationConfig } from './inventory-reservation.config';
import { InventoryReservationMetrics } from './inventory-reservation.metrics';
import { InventoryReservationService } from './inventory-reservation.service';
import { InventoryAllocationService } from './inventory-allocation.service';
import { InventoryReservationWorker } from './inventory-reservation.worker';
import { StockTransferService } from './stock-transfer.service';
import { InventoryReservationAdminController } from './presentation/inventory-reservation-admin.controller';
import { InventoryAdminController } from './presentation/inventory-admin.controller';

/**
 * Inventory reservation, multi-outlet allocation & stock transfers. Global so
 * OrdersService, AdminService, and OrderCancellationService (provided in several
 * modules) all resolve the same services via their @Optional() injection points.
 */
@Global()
@Module({
  imports: [ShippingModule, DeliveryCoverageModule],
  controllers: [InventoryReservationAdminController, InventoryAdminController],
  providers: [
    InventoryReservationService,
    InventoryAllocationService,
    StockTransferService,
    InventoryReservationMetrics,
    { provide: INVENTORY_RESERVATION_CONFIG, useFactory: () => loadInventoryReservationConfig() },
    InventoryReservationWorker,
  ],
  exports: [InventoryReservationService, InventoryAllocationService, StockTransferService],
})
export class InventoryModule {}
