import { Injectable, Logger } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsRegistry } from '../metrics/metrics.registry';

/**
 * Telemetry for retention sweeps and recovery (redrive). Dual-emits structured
 * logs and Prometheus instruments. `table` and `type` labels are bounded sets.
 */
@Injectable()
export class LifecycleMetrics {
  private readonly logger = new Logger('LifecycleRetention');

  private readonly deleted: Counter<string>; // {table}
  private readonly duration: Histogram<string>; // {table}
  private readonly lastRun: Gauge<string>;
  private readonly redriven: Counter<string>; // {type=outbox|notification}
  private readonly dlqRedriven: Counter<string>;

  constructor(registry: MetricsRegistry) {
    this.deleted = registry.counter('masular_retention_deleted_total', 'Rows deleted by retention', ['table']);
    this.duration = registry.histogram(
      'masular_retention_duration_seconds',
      'Per-policy retention sweep duration',
      [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
      ['table'],
    );
    this.lastRun = registry.gauge('masular_retention_last_run_timestamp_seconds', 'Unix time of the last retention sweep');
    this.redriven = registry.counter('masular_redrive_total', 'FAILED rows reset to PENDING by redrive', ['type']);
    this.dlqRedriven = registry.counter('masular_dlq_redrive_total', 'Messages shoveled from the consumer DLQ');
  }

  swept(fields: { table: string; wouldDeleteCount: number; deletedCount: number; durationMs: number; dryRun: boolean }): void {
    this.deleted.inc({ table: fields.table }, fields.deletedCount);
    this.duration.observe({ table: fields.table }, fields.durationMs / 1000);
    this.lastRun.set(Date.now() / 1000);
    this.logger.log({ metric: 'retention.swept', ...fields });
  }

  redrive(type: 'outbox' | 'notification', count: number): void {
    this.redriven.inc({ type }, count);
  }

  dlqRedrive(count: number): void {
    this.dlqRedriven.inc(count);
  }
}
