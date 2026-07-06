import { Injectable, Logger } from '@nestjs/common';
import { Counter } from 'prom-client';
import { MetricsRegistry } from '../../infrastructure/metrics/metrics.registry';

/** Telemetry for the inventory reservation worker. Dual-emits logs + Prometheus. */
@Injectable()
export class InventoryReservationMetrics {
  private readonly logger = new Logger('InventoryReservation');
  private readonly released: Counter<string>;
  private readonly failed: Counter<string>;

  constructor(registry: MetricsRegistry) {
    this.released = registry.counter('masular_inventory_reservation_expired_total', 'Reservations auto-expired by the worker');
    this.failed = registry.counter('masular_inventory_reservation_expire_failed_total', 'Reservation expire attempts that failed');
  }

  expired(count = 1): void {
    if (count <= 0) return;
    this.released.inc(count);
    this.logger.log({ metric: 'inventory.reservation.expired', count });
  }

  failure(): void {
    this.failed.inc();
  }
}
