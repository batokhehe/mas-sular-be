import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { LOG_CONFIG, LogConfig } from './log.config';
import { LogService } from './log.service';

/**
 * Daily retention sweep for SystemLog: deletes rows older than LOG_RETENTION_DAYS
 * (default 90). Self-scheduled (setTimeout, unref'd), single-flight, retry-next-tick.
 * Disabled with the rest of logging or via SYSTEM_LOG_RETENTION_ENABLED=false.
 */
@Injectable()
export class LogRetentionWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('LogRetentionWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  // Overridable seam for deterministic tests.
  private nowMs: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly logs: LogService,
    @Inject(LOG_CONFIG) private readonly config: LogConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled || !this.config.retentionEnabled) {
      this.logger.log('Log retention disabled');
      return;
    }
    this.logger.log(`Log retention starting (retentionDays=${this.config.retentionDays}, interval=${this.config.retentionIntervalMs}ms)`);
    this.schedule(this.config.retentionInitialDelayMs);
  }

  async onModuleDestroy(): Promise<void> {
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
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(`log retention sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
      this.schedule(this.config.retentionIntervalMs);
    }
  }

  /** Delete logs older than the cutoff. Returns the number deleted. */
  async sweep(): Promise<number> {
    const cutoff = new Date(this.nowMs() - this.config.retentionDays * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.systemLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    this.logs.write({
      level: 'INFO',
      module: 'worker.log-retention',
      action: 'retention.sweep',
      message: `Pruned ${count} logs older than ${this.config.retentionDays}d`,
      metadata: { deleted: count, cutoff: cutoff.toISOString() },
    });
    return count;
  }
}
