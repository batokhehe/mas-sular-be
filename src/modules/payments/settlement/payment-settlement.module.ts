import { Module } from '@nestjs/common';
import { OrderCancellationService } from '../../orders/order-cancellation.service';
import { ShipmentModule } from '../../shipment/shipment.module';
import { PaymentSettlementService } from './payment-settlement.service';

/**
 * The single settlement path, shared by admin verification and gateway webhooks.
 *
 * Imports ShipmentModule for the existing post-payment booking; ShipmentModule has
 * no imports of its own, so this introduces no cycle. InventoryReservationService
 * arrives from the @Global InventoryModule, and PrismaService from @Global
 * DatabaseModule.
 */
@Module({
  imports: [ShipmentModule],
  providers: [
    // MUST be provided here. `PaymentSettlementService` takes it @Optional(), and
    // without it in this module's scope every DI-constructed instance silently loses
    // the restock: `fail()` and `expire()` would flip the payment but leave the order
    // live and the stock held. Unit tests never caught this because they all pass a
    // cancellation double; the Phase 5G integration run did.
    OrderCancellationService,
    PaymentSettlementService,
  ],
  exports: [PaymentSettlementService],
})
export class PaymentSettlementModule {}
