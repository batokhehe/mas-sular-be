import { Injectable, Optional } from '@nestjs/common';
import type { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsRegistry } from '../metrics/metrics.registry';

/**
 * Counters/gauges for the notification platform. The JSON `snapshot()` feeds the
 * admin observability endpoint; when the global MetricsRegistry is available the
 * same instruments are ALSO registered with prom-client so /metrics can alert on
 * DLQ growth, push failures, and SSE fan-out (dual-emit, same pattern as
 * RelayMetrics). Optional so unit tests can construct the seam standalone.
 */
@Injectable()
export class AdminNotificationMetrics {
  private counters = { created: 0, pushSuccess: 0, pushFailed: 0, consumed: 0, duplicates: 0, deadLettered: 0 };
  private sse = { active: 0 };
  private latency = { totalMs: 0, samples: 0 };

  private readonly prom: {
    created: Counter<string>;
    pushSuccess: Counter<string>;
    pushFailed: Counter<string>;
    consumed: Counter<string>;
    duplicates: Counter<string>;
    deadLettered: Counter<string>;
    sseActive: Gauge<string>;
    processing: Histogram<string>;
  } | null;

  constructor(@Optional() registry?: MetricsRegistry) {
    this.prom = registry
      ? {
          created: registry.counter('masular_admin_notifications_created_total', 'Admin notifications fanned out (rows created)'),
          pushSuccess: registry.counter('masular_admin_push_success_total', 'Web-push deliveries accepted by FCM'),
          pushFailed: registry.counter('masular_admin_push_failed_total', 'Web-push deliveries that failed (invalid/transient)'),
          consumed: registry.counter('masular_admin_notification_events_total', 'Domain events consumed by the notification worker'),
          duplicates: registry.counter('masular_admin_notification_duplicates_total', 'Redelivered events deduplicated'),
          deadLettered: registry.counter('masular_admin_notification_dead_lettered_total', 'Notification deliveries sent to the DLQ'),
          sseActive: registry.gauge('masular_admin_sse_connections', 'Open admin SSE connections'),
          processing: registry.histogram(
            'masular_admin_notification_processing_seconds',
            'Event → dispatched latency',
            [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
          ),
        }
      : null;
  }

  created(count = 1): void {
    this.counters.created += count;
    this.prom?.created.inc(count);
  }
  pushSuccess(): void {
    this.counters.pushSuccess += 1;
    this.prom?.pushSuccess.inc();
  }
  pushFailed(): void {
    this.counters.pushFailed += 1;
    this.prom?.pushFailed.inc();
  }
  consumed(): void {
    this.counters.consumed += 1;
    this.prom?.consumed.inc();
  }
  duplicate(): void {
    this.counters.duplicates += 1;
    this.prom?.duplicates.inc();
  }
  deadLettered(): void {
    this.counters.deadLettered += 1;
    this.prom?.deadLettered.inc();
  }
  sseConnected(): void {
    this.sse.active += 1;
    this.prom?.sseActive.set(this.sse.active);
  }
  sseDisconnected(): void {
    this.sse.active = Math.max(0, this.sse.active - 1);
    this.prom?.sseActive.set(this.sse.active);
  }
  observeProcessing(ms: number): void {
    this.latency.totalMs += ms;
    this.latency.samples += 1;
    this.prom?.processing.observe(ms / 1000);
  }

  snapshot() {
    return {
      activeSseConnections: this.sse.active,
      notificationsCreated: this.counters.created,
      eventsConsumed: this.counters.consumed,
      duplicates: this.counters.duplicates,
      deadLettered: this.counters.deadLettered,
      pushSuccess: this.counters.pushSuccess,
      pushFailed: this.counters.pushFailed,
      avgProcessingMs: this.latency.samples ? Math.round(this.latency.totalMs / this.latency.samples) : 0,
    };
  }
}
