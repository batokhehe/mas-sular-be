import { Inject, Injectable, Logger, Optional, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { LogService } from '../logging/log.service';
import { LIFECYCLE_CONFIG, LifecycleConfig } from './lifecycle.config';
import { LifecycleMetrics } from './lifecycle.metrics';

export interface RetentionPolicy {
  /** table_name for metrics/logging. */
  name: string;
  /** Backtick-quoted table identifier. */
  table: string;
  /** WHERE clause with a single `?` for the cutoff timestamp. Status/lease-safe. */
  where: string;
  /** The cutoff timestamp bound to the `?`. */
  cutoff: Date;
}

export interface SweepResult {
  table: string;
  wouldDeleteCount: number;
  deletedCount: number;
  durationMs: number;
}

/**
 * Daily, self-scheduled, batched retention. Each policy targets exactly one
 * terminal/expired slice via an explicit status + time predicate, and excludes
 * leased (in-flight) rows. PENDING rows, leased rows, and live PROCESSING
 * idempotency rows are never matched. Disabled by default; dry-run counts only.
 */
@Injectable()
export class RetentionWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('RetentionWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  private nowMs: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: LifecycleMetrics,
    @Inject(LIFECYCLE_CONFIG) private readonly config: LifecycleConfig,
    @Optional() private readonly logs?: LogService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('Retention disabled (RETENTION_ENABLED=false)');
      return;
    }
    this.logger.log(
      `Retention starting (dryRun=${this.config.dryRun}, batch=${this.config.batchSize}, interval=${this.config.intervalMs}ms)`,
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
      const startedAt = this.nowMs();
      try {
        const results = await this.runOnce();
        const deleted = results.reduce((sum, r) => sum + r.deletedCount, 0);
        this.logs?.write({ level: 'INFO', module: 'worker.retention', action: 'tick', message: `retention: deleted=${deleted} across ${results.length} policies`, durationMs: this.nowMs() - startedAt, metadata: { deleted, policies: results.length } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`retention run failed: ${message}`);
        this.logs?.write({ level: 'ERROR', module: 'worker.retention', action: 'tick.failed', message, durationMs: this.nowMs() - startedAt, metadata: { stack: err instanceof Error ? err.stack : undefined } });
      }
    })();
    await this.inFlight;
    this.inFlight = null;
    this.running = false;
    this.scheduleNext(this.config.intervalMs);
  }

  /** Run every policy once (sequentially). */
  async runOnce(): Promise<SweepResult[]> {
    const results: SweepResult[] = [];
    for (const policy of this.policies()) {
      results.push(await this.sweepPolicy(policy));
    }
    return results;
  }

  policies(): RetentionPolicy[] {
    const now = this.nowMs();
    const cutoff = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000);
    return [
      // OutboxEvent: delivered history (PUBLISHED). FAILED kept far longer, separate policy.
      { name: 'OutboxEvent.PUBLISHED', table: '`OutboxEvent`', where: "`status` = 'PUBLISHED' AND `lockedUntil` IS NULL AND `createdAt` < ?", cutoff: cutoff(this.config.outboxPublishedDays) },
      { name: 'OutboxEvent.FAILED', table: '`OutboxEvent`', where: "`status` = 'FAILED' AND `lockedUntil` IS NULL AND `createdAt` < ?", cutoff: cutoff(this.config.outboxFailedDays) },
      // ProcessedEvent: dedup ledger; window >> redelivery window.
      { name: 'ProcessedEvent', table: '`ProcessedEvent`', where: '`processedAt` < ?', cutoff: cutoff(this.config.processedDays) },
      // NotificationOutbox: SENT by sentAt; FAILED kept far longer.
      { name: 'NotificationOutbox.SENT', table: '`NotificationOutbox`', where: "`status` = 'SENT' AND `lockedUntil` IS NULL AND `sentAt` < ?", cutoff: cutoff(this.config.notificationSentDays) },
      { name: 'NotificationOutbox.FAILED', table: '`NotificationOutbox`', where: "`status` = 'FAILED' AND `lockedUntil` IS NULL AND `createdAt` < ?", cutoff: cutoff(this.config.notificationFailedDays) },
      // IdempotencyKey: expired keys (live PROCESSING rows have a future expiresAt → never matched).
      { name: 'IdempotencyKey', table: '`IdempotencyKey`', where: '`expiresAt` < ?', cutoff: new Date(now) },
      // PaymentUploadToken: deleted only N days AFTER expiry, so active and recently-
      // expired tokens (future or within-window expiresAt) are never matched.
      { name: 'PaymentUploadToken', table: '`PaymentUploadToken`', where: '`expiresAt` < ?', cutoff: cutoff(this.config.uploadTokenExpiredDays) },
    ];
  }

  async sweepPolicy(policy: RetentionPolicy): Promise<SweepResult> {
    const start = this.nowMs();

    if (this.config.dryRun) {
      const wouldDeleteCount = await this.countMatching(policy);
      const result: SweepResult = { table: policy.name, wouldDeleteCount, deletedCount: 0, durationMs: this.nowMs() - start };
      this.metrics.swept({ ...result, dryRun: true });
      this.logger.log(`[dry-run] ${policy.name}: would_delete=${wouldDeleteCount}`);
      return result;
    }

    const limit = Math.trunc(this.config.batchSize);
    let deletedCount = 0;
    for (let batch = 0; batch < this.config.maxBatchesPerPolicy; batch += 1) {
      const affected = await this.deleteBatch(policy, limit);
      deletedCount += affected;
      if (affected < limit) break;
    }
    const result: SweepResult = { table: policy.name, wouldDeleteCount: 0, deletedCount, durationMs: this.nowMs() - start };
    this.metrics.swept({ ...result, dryRun: false });
    if (deletedCount > 0) this.logger.log(`${policy.name}: deleted=${deletedCount}`);
    return result;
  }

  private async deleteBatch(policy: RetentionPolicy, limit: number): Promise<number> {
    // limit is a validated integer from config → injection-safe to inline; cutoff is parameterized.
    const affected = await this.prisma.$executeRawUnsafe(
      `DELETE FROM ${policy.table} WHERE ${policy.where} LIMIT ${limit}`,
      policy.cutoff,
    );
    return Number(affected);
  }

  private async countMatching(policy: RetentionPolicy): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ c: number | bigint }>>(
      `SELECT COUNT(*) AS c FROM ${policy.table} WHERE ${policy.where}`,
      policy.cutoff,
    );
    return Number(rows[0]?.c ?? 0);
  }
}
