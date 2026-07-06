import { Injectable, Logger } from '@nestjs/common';
import { Counter, Gauge } from 'prom-client';
import { MetricsRegistry } from '../../infrastructure/metrics/metrics.registry';

/** Telemetry for the shipment reconciliation worker. Dual-emits logs + Prometheus. */
@Injectable()
export class ShipmentReconciliationMetrics {
  private readonly logger = new Logger('ShipmentReconciliation');
  private readonly pending: Gauge<string>;
  private readonly successful: Counter<string>;
  private readonly failed: Counter<string>;

  constructor(registry: MetricsRegistry) {
    this.pending = registry.gauge('masular_shipment_reconciliation_pending', 'Un-booked shipments awaiting reconciliation');
    this.successful = registry.counter('masular_shipment_reconciliation_successful_total', 'Shipments booked by reconciliation');
    this.failed = registry.counter('masular_shipment_reconciliation_failed_total', 'Reconciliation booking attempts that failed');
  }

  setPending(count: number): void {
    this.pending.set(count);
  }

  success(): void {
    this.successful.inc();
    this.logger.log({ metric: 'shipment.reconciliation.successful' });
  }

  failure(): void {
    this.failed.inc();
    this.logger.warn({ metric: 'shipment.reconciliation.failed' });
  }
}
