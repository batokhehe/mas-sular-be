import { Module } from '@nestjs/common';
import { SHIPPING_CONFIG, loadShippingConfig } from '../shipping/shipping.config';
import { JneShipmentProvider } from './infrastructure/providers/jne-shipment.provider';
import { PaxelShipmentProvider } from './infrastructure/providers/paxel-shipment.provider';
import { ShipmentAdminController } from './presentation/shipment-admin.controller';
import { SHIPMENT_PROVIDERS, ShipmentProviderFactory } from './shipment-provider.factory';
import { SHIPMENT_TRACKING_CONFIG, loadShipmentTrackingConfig } from './shipment-tracking.config';
import { ShipmentTrackingWorker } from './shipment-tracking.worker';
import { SHIPMENT_RECONCILIATION_CONFIG, loadShipmentReconciliationConfig } from './shipment-reconciliation.config';
import { ShipmentReconciliationMetrics } from './shipment-reconciliation.metrics';
import { ShipmentReconciliationWorker } from './shipment-reconciliation.worker';
import { ShipmentService } from './shipment.service';
import { ShipmentStatusMapper } from './shipment-status.mapper';
import { ShipmentSyncService } from './shipment-sync.service';

@Module({
  controllers: [ShipmentAdminController],
  providers: [
    // Provider credentials (same env as quotation; env.validation asserts at boot).
    { provide: SHIPPING_CONFIG, useFactory: () => loadShippingConfig() },
    PaxelShipmentProvider,
    JneShipmentProvider,
    // === Fulfillment courier registry ===
    // Add a courier by implementing ShipmentProvider and appending it here.
    {
      provide: SHIPMENT_PROVIDERS,
      useFactory: (paxel: PaxelShipmentProvider, jne: JneShipmentProvider) => [paxel, jne],
      inject: [PaxelShipmentProvider, JneShipmentProvider],
    },
    ShipmentProviderFactory,
    ShipmentService,
    ShipmentStatusMapper,
    ShipmentSyncService,
    { provide: SHIPMENT_TRACKING_CONFIG, useFactory: () => loadShipmentTrackingConfig() },
    ShipmentTrackingWorker,
    // C2: recover paid orders whose shipment was never booked (crash-after-verify).
    ShipmentReconciliationMetrics,
    { provide: SHIPMENT_RECONCILIATION_CONFIG, useFactory: () => loadShipmentReconciliationConfig() },
    ShipmentReconciliationWorker,
  ],
  exports: [ShipmentService, ShipmentSyncService, ShipmentStatusMapper],
})
export class ShipmentModule {}
