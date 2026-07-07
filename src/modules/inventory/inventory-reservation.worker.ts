import { Inject, Injectable, Logger, Optional, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ReservationStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { LogService } from '../../infrastructure/logging/log.service';
import { INVENTORY_RESERVATION_CONFIG, InventoryReservationConfig } from './inventory-reservation.config';
import { InventoryReservationMetrics } from './inventory-reservation.metrics';
import { InventoryReservationService } from './inventory-reservation.service';

/**
 * Self-scheduled worker that releases EXPIRED reservations: reservations still
 * RESERVED past their expiresAt are transitioned to EXPIRED (freeing the hold).
 * Follows the PaymentLifecycleWorker pattern — config-gated, batched, per-row CAS
 * (concurrency-safe / lease-equivalent), retried on the next tick, with metrics and
 * a throttled health log. Disabled by default.
 */
@Injectable()
export class InventoryReservationWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('InventoryReservationWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private lastHealthLogAt = 0;

  // Overridable seam for deterministic tests.
  private nowMs: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: InventoryReservationService,
    private readonly metrics: InventoryReservationMetrics,
    @Inject(INVENTORY_RESERVATION_CONFIG) private readonly config: InventoryReservationConfig,
    @Optional() private readonly logs?: LogService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('Inventory reservation worker disabled (INVENTORY_RESERVATION_WORKER_ENABLED=false)');
      return;
    }
    this.logger.log(`Inventory reservation worker starting (interval=${this.config.pollIntervalMs}ms, batch=${this.config.batchSize})`);
    this.scheduleNext(this.config.initialDelayMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // already logged
      }
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.runTick(), delayMs);
    this.timer.unref();
  }

  private async runTick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    this.inFlight = (async () => {
      const startedAt = this.nowMs();
      try {
        const released = await this.releaseExpired();
        this.maybeHealthLog(released);
        this.logs?.write({ level: 'INFO', module: 'worker.inventory-reservation', action: 'tick', message: `inventory reservation: released=${released}`, durationMs: this.nowMs() - startedAt, metadata: { released } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`inventory reservation tick failed: ${message}`);
        this.logs?.write({ level: 'ERROR', module: 'worker.inventory-reservation', action: 'tick.failed', message, durationMs: this.nowMs() - startedAt, metadata: { stack: err instanceof Error ? err.stack : undefined } });
      }
    })();
    await this.inFlight;
    this.inFlight = null;
    this.running = false;
    this.scheduleNext(this.config.pollIntervalMs);
  }

  /** Sweep a batch of due reservations; CAS-expire each. Returns the count released. */
  async releaseExpired(): Promise<number> {
    const due = await this.prisma.inventoryReservation.findMany({
      where: { status: ReservationStatus.RESERVED, expiresAt: { not: null, lte: new Date(this.nowMs()) } },
      orderBy: { expiresAt: 'asc' },
      take: this.config.batchSize,
      select: { id: true },
    });

    let released = 0;
    for (const r of due) {
      try {
        if (await this.reservations.expireReservation(r.id)) released += 1;
      } catch (err) {
        this.metrics.failure();
        this.logger.error(`expire reservation ${r.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (released > 0) this.metrics.expired(released);
    return released;
  }

  private maybeHealthLog(released: number): void {
    const now = this.nowMs();
    if (now - this.lastHealthLogAt >= this.config.healthLogIntervalMs) {
      this.lastHealthLogAt = now;
      this.logger.log({ health: 'inventory-reservation-worker', lastBatchReleased: released });
    }
  }
}
