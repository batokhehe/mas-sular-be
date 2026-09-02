import { Module } from '@nestjs/common';
import { SHIPPING_CONFIG, assertJneEnvironment, loadShippingConfig } from '../shipping/shipping.config';
import { JneShipmentProvider } from './infrastructure/providers/jne-shipment.provider';
import { JneOriginBootValidator } from './jne-origin-boot.validator';
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
    //
    // This module builds SHIPPING_CONFIG itself rather than importing ShippingModule,
    // so assertShippingConfigured() never ran here - and THIS is the module that owns
    // JNE tracking and cancel, the two paths that actually spend jne.baseUrl. The
    // environment guard is applied explicitly so that bypass cannot exist
    // (PAXELBOX-61K). Paxel's credential checks stay with ShippingModule.
    {
      provide: SHIPPING_CONFIG,
      useFactory: () => {
        const config = loadShippingConfig();
        assertJneEnvironment(config.jne);
        return config;
      },
    },
    PaxelShipmentProvider,
    JneShipmentProvider,
    // Checks JNE_ORIGIN_CODE against JNE's own ORIGIN master at bootstrap -
    // the check that would have caught BDO10056 (PAXELBOX-61P).
    JneOriginBootValidator,
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
