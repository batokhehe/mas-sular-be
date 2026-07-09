import { Injectable, Logger, Optional, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { LogService } from '../logging/log.service';
import { AdminNotificationRepository } from './admin-notification.repository';

function intOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * Daily retention sweep: prunes old notifications (NOTIFICATION_RETENTION_DAYS,
 * default 90) and stale push tokens (PUSH_TOKEN_STALE_DAYS, default 60).
 * Self-scheduled, single-flight — same pattern as every other worker here.
 */
@Injectable()
export class NotificationRetentionWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('NotificationRetentionWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  private readonly enabled = (process.env.NOTIFICATION_RETENTION_ENABLED ?? 'true') !== 'false';
  private readonly retentionDays = intOr(process.env.NOTIFICATION_RETENTION_DAYS, 90);
  private readonly tokenStaleDays = intOr(process.env.PUSH_TOKEN_STALE_DAYS, 60);
  private readonly intervalMs = intOr(process.env.NOTIFICATION_RETENTION_INTERVAL_MS, 24 * 60 * 60 * 1000);

  constructor(
    private readonly repository: AdminNotificationRepository,
    @Optional() private readonly logs?: LogService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Notification retention disabled');
      return;
    }
    this.schedule(60_000);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const result = await this.repository.cleanup(this.retentionDays, this.tokenStaleDays);
      this.logs?.write({
        level: 'INFO', module: 'worker.notification-retention', action: 'tick',
        message: `notification retention: notifications=${result.notifications} tokens=${result.tokens}`,
        durationMs: Date.now() - startedAt, metadata: { ...result },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`notification retention failed: ${message}`);
      this.logs?.write({ level: 'ERROR', module: 'worker.notification-retention', action: 'tick.failed', message, durationMs: Date.now() - startedAt });
    } finally {
      this.running = false;
      this.schedule(this.intervalMs);
    }
  }
}
