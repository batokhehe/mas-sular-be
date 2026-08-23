import { Inject, Injectable, Logger, Optional, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PaymentStatus, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { LogService } from '../../infrastructure/logging/log.service';
import { SHIPMENT_RECONCILIATION_CONFIG, ShipmentReconciliationConfig } from './shipment-reconciliation.config';
import { ShipmentReconciliationMetrics } from './shipment-reconciliation.metrics';
import { AWAITING_PICKUP_SCHEDULE, BOOKING_IN_PROGRESS, ShipmentService } from './shipment.service';

/**
 * Recovers orders that were paid but never got a shipment booked — e.g. the process
 * crashed after the verify transaction committed but before
 * ShipmentService.createForOrderSafe() ran. Finds PAID orders whose shipment is
 * still RATE_SELECTED with no tracking number (past a grace delay) and books them
 * via the existing (idempotent) ShipmentService.
 *
 * Concurrency-safe WITHOUT touching ShipmentService: each candidate is CAS-claimed
 * (status → PENDING) so exactly one worker/instance books it; a shipment left mid-
 * claim by a crashed run (PENDING + no tracking, older than the delay) is reclaimed
 * on a later tick. Follows the existing worker pattern (self-scheduled, batched,
 * retry-next-tick, structured logging, health metrics). Disabled by default.
 */
@Injectable()
export class ShipmentReconciliationWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ShipmentReconciliationWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private lastHealthLogAt = 0;

  // Overridable seam for deterministic tests.
  private nowMs: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentService,
    private readonly metrics: ShipmentReconciliationMetrics,
    @Inject(SHIPMENT_RECONCILIATION_CONFIG) private readonly config: ShipmentReconciliationConfig,
    // Optional so existing tests keep constructing positionally; persists tick outcomes.
    @Optional() private readonly logs?: LogService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('Shipment reconciliation disabled (SHIPMENT_RECONCILIATION_ENABLED=false)');
      return;
    }
    this.logger.log(
      `Shipment reconciliation starting (interval=${this.config.pollIntervalMs}ms, batch=${this.config.batchSize}, delay=${this.config.delayMs}ms)`,
    );
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
      try {
        const { booked, failed } = await this.reconcile();
        this.maybeHealthLog(booked);
        if (booked > 0 || failed > 0) {
          this.logs?.write({
            level: failed > 0 ? 'WARN' : 'INFO', module: 'worker.shipment-reconciliation', action: 'tick',
            message: `shipment reconciliation: booked=${booked} failed=${failed}`,
            metadata: { booked, failed },
          });
        }
      } catch (err) {
        // Transient failure → retried on the next tick.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`shipment reconciliation tick failed: ${message}`);
        this.logs?.write({ level: 'ERROR', module: 'worker.shipment-reconciliation', action: 'tick.failed', message, metadata: { stack: err instanceof Error ? err.stack : undefined } });
      }
    })();
    await this.inFlight;
    this.inFlight = null;
    this.running = false;
    this.scheduleNext(this.config.pollIntervalMs);
  }

  /** One sweep: claim + book each stranded shipment. Returns counts. */
  async reconcile(): Promise<{ booked: number; failed: number; pending: number }> {
    const cutoff = new Date(this.nowMs() - this.config.delayMs);
    const candidates = await this.prisma.shipment.findMany({
      where: {
        trackingNumber: null,
        order: { payment: { status: PaymentStatus.PAID } },
        OR: [
          // Never attempted: paid but shipment still RATE_SELECTED past the grace delay.
          { status: ShipmentStatus.RATE_SELECTED, order: { createdAt: { lte: cutoff } } },
          // Reclaim: claimed by a run that crashed mid-book (stale PENDING).
          { status: ShipmentStatus.PENDING, updatedAt: { lte: cutoff } },
        ],
      },
      select: { orderId: true },
      orderBy: { createdAt: 'asc' },
      take: this.config.batchSize,
    });

    this.metrics.setPending(candidates.length);

    let booked = 0;
    let failed = 0;
    for (const { orderId } of candidates) {
      if (this.stopped) break;
      // Booking claims moved INTO ShipmentService.createForOrder (audit F3) so
      // every path — verify auto-create, admin retry, this worker — shares ONE
      // CAS claim. A lost claim comes back as BOOKING_IN_PROGRESS → skip, not a
      // failure (another caller is booking or just booked it).
      const outcome = await this.shipments.createForOrderSafe(orderId);
      if (!outcome.ok && outcome.error === BOOKING_IN_PROGRESS) {
        this.logger.log({ event: 'reconciliation.skipped', orderId, reason: 'not_claimed' });
        continue;
      }
      // Waiting on a person, not broken: a courier that needs an admin-selected
      // pickup slot has no schedule yet. Skipping keeps it out of the failure
      // metric, which would otherwise alarm on every order awaiting packing.
      if (!outcome.ok && outcome.error === AWAITING_PICKUP_SCHEDULE) {
        this.logger.log({ event: 'reconciliation.skipped', orderId, reason: 'awaiting_pickup_schedule' });
        continue;
      }
      if (outcome.ok) {
        booked += 1;
        this.metrics.success();
        this.logger.log({ event: 'reconciliation.booked', orderId, trackingNumber: outcome.trackingNumber });
      } else {
        failed += 1;
        this.metrics.failure();
        this.logger.warn({ event: 'reconciliation.failed', orderId, error: outcome.error });
      }
    }
    return { booked, failed, pending: candidates.length };
  }

  private maybeHealthLog(booked: number): void {
    const now = this.nowMs();
    if (now - this.lastHealthLogAt >= this.config.healthLogIntervalMs) {
      this.lastHealthLogAt = now;
      this.logger.log({ health: 'shipment-reconciliation-worker', lastBatchBooked: booked });
    }
  }
}
