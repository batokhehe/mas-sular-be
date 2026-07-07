import { Inject, Injectable, Logger, Optional, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { LogService } from '../../infrastructure/logging/log.service';
import { SHIPMENT_TRACKING_CONFIG, ShipmentTrackingConfig } from './shipment-tracking.config';
import { ShipmentSyncService } from './shipment-sync.service';

/**
 * Background worker that polls the courier for non-terminal shipments, advances
 * shipment + order status, and triggers the "delivered" WhatsApp. Flag-gated
 * (SHIPMENT_TRACKING_ENABLED) — off by default; a single-flight setTimeout loop.
 */
@Injectable()
export class ShipmentTrackingWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ShipmentTrackingWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly sync: ShipmentSyncService,
    @Inject(SHIPMENT_TRACKING_CONFIG) private readonly config: ShipmentTrackingConfig,
    @Optional() private readonly logs?: LogService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('Shipment tracking disabled (SHIPMENT_TRACKING_ENABLED=false)');
      return;
    }
    this.logger.log(`Shipment tracking enabled; polling every ${this.config.pollIntervalMs}ms`);
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.config.pollIntervalMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) {
      this.schedule();
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      const updated = await this.sync.syncAll(this.config.batchSize);
      if (updated > 0) this.logger.log(`Shipment tracking updated ${updated} shipment(s)`);
      this.logs?.write({ level: 'INFO', module: 'worker.shipment-tracking', action: 'tick', message: `shipment tracking: updated=${updated}`, durationMs: Date.now() - startedAt, metadata: { updated } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Shipment tracking tick failed: ${message}`);
      this.logs?.write({ level: 'ERROR', module: 'worker.shipment-tracking', action: 'tick.failed', message, durationMs: Date.now() - startedAt, metadata: { stack: err instanceof Error ? err.stack : undefined } });
    } finally {
      this.running = false;
      this.schedule();
    }
  }
}
