import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsRegistry } from './metrics.registry';

/**
 * Metrics seam for the outbox relay (previously log-only). Counts publish
 * outcomes and tracks backlog/age gauges set on the relay's health tick.
 */
@Injectable()
export class RelayMetrics {
  private readonly published: Counter<string>;
  private readonly retry: Counter<string>;
  private readonly failed: Counter<string>;
  private readonly backlog: Gauge<string>;
  private readonly failedBacklog: Gauge<string>;
  private readonly oldestAge: Gauge<string>;
  private readonly publishDuration: Histogram<string>;

  constructor(registry: MetricsRegistry) {
    this.published = registry.counter('masular_relay_published_total', 'Outbox events published to the broker (confirmed)');
    this.retry = registry.counter('masular_relay_retry_total', 'Outbox publishes scheduled for retry');
    this.failed = registry.counter('masular_relay_failed_total', 'Outbox events terminally FAILED');
    this.backlog = registry.gauge('masular_relay_backlog', 'PENDING OutboxEvent rows');
    this.failedBacklog = registry.gauge('masular_relay_failed_backlog', 'FAILED OutboxEvent rows');
    this.oldestAge = registry.gauge('masular_relay_oldest_pending_age_seconds', 'Age of the oldest PENDING outbox event');
    this.publishDuration = registry.histogram(
      'masular_relay_publish_duration_seconds',
      'Publish + broker-confirm latency',
      [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    );
  }

  publishedOk(durationSeconds: number): void {
    this.published.inc();
    this.publishDuration.observe(durationSeconds);
  }

  retried(): void {
    this.retry.inc();
  }

  failedTerminal(): void {
    this.failed.inc();
  }

  health(fields: { pending: number; failed: number; oldestPendingAgeMs: number }): void {
    this.backlog.set(fields.pending);
    this.failedBacklog.set(fields.failed);
    this.oldestAge.set(fields.oldestPendingAgeMs / 1000);
  }
}
