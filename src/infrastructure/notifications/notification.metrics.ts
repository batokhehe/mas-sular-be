import { Injectable, Logger } from '@nestjs/common';
import { Counter, Gauge } from 'prom-client';
import { MetricsRegistry } from '../metrics/metrics.registry';

/**
 * Metrics seam for the notification pipeline (consumer + sender). Dual-emits:
 * structured log lines (for debugging) and Prometheus instruments (for alerting).
 */
@Injectable()
export class NotificationMetrics {
  private readonly logger = new Logger('NotificationMetrics');

  // consumer
  private readonly cEnqueued: Counter<string>;
  private readonly cDuplicate: Counter<string>;
  private readonly cSkipped: Counter<string>; // {reason} — bounded set
  private readonly cRetried: Counter<string>;
  private readonly cDeadLettered: Counter<string>; // unlabeled: reasons are free-form (kept in logs)
  private readonly cPause: Counter<string>;
  private readonly gConsumerPaused: Gauge<string>;

  // sender
  private readonly sClaimed: Counter<string>;
  private readonly sSent: Counter<string>;
  private readonly sRetried: Counter<string>;
  private readonly sFailedPermanent: Counter<string>;
  private readonly sFailedExhausted: Counter<string>;
  private readonly sResult: Counter<string>; // {result=success|transient|permanent}
  private readonly sBreakerTrip: Counter<string>;
  private readonly gBreakerOpen: Gauge<string>;
  private readonly gBacklog: Gauge<string>;
  private readonly gFailedBacklog: Gauge<string>;
  private readonly gOldestAge: Gauge<string>;

  constructor(registry: MetricsRegistry) {
    this.cEnqueued = registry.counter('masular_notification_consumer_enqueued_total', 'order.created events enqueued to NotificationOutbox');
    this.cDuplicate = registry.counter('masular_notification_consumer_duplicate_total', 'Duplicate deliveries dropped by dedup');
    this.cSkipped = registry.counter('masular_notification_consumer_skipped_total', 'Deliveries skipped', ['reason']);
    this.cRetried = registry.counter('masular_notification_consumer_retried_total', 'Deliveries routed to the retry queue');
    this.cDeadLettered = registry.counter('masular_notification_consumer_dead_lettered_total', 'Deliveries dead-lettered');
    this.cPause = registry.counter('masular_notification_consumer_pause_total', 'Consumer infra pauses');
    this.gConsumerPaused = registry.gauge('masular_notification_consumer_paused', 'Consumer paused state (1=paused)');

    this.sClaimed = registry.counter('masular_notification_sender_claimed_total', 'NotificationOutbox rows claimed by the sender');
    this.sSent = registry.counter('masular_notification_sender_sent_total', 'Notifications successfully sent');
    this.sRetried = registry.counter('masular_notification_sender_retried_total', 'Notification sends scheduled for retry');
    this.sFailedPermanent = registry.counter('masular_notification_sender_failed_permanent_total', 'Notifications permanently failed');
    this.sFailedExhausted = registry.counter('masular_notification_sender_failed_exhausted_total', 'Notifications failed after exhausting retries');
    this.sResult = registry.counter('masular_notification_sender_result_total', 'Provider send outcomes by class', ['result']);
    this.sBreakerTrip = registry.counter('masular_notification_sender_breaker_trip_total', 'Sender circuit-breaker trips');
    this.gBreakerOpen = registry.gauge('masular_notification_sender_breaker_open', 'Sender breaker state (1=open)');
    this.gBacklog = registry.gauge('masular_notification_backlog', 'PENDING NotificationOutbox rows');
    this.gFailedBacklog = registry.gauge('masular_notification_failed_backlog', 'FAILED NotificationOutbox rows');
    this.gOldestAge = registry.gauge('masular_notification_sender_oldest_pending_age_seconds', 'Age of the oldest PENDING notification');
  }

  private emit(metric: string, fields: Record<string, unknown> = {}): void {
    this.logger.log({ metric, ...fields });
  }

  // ---- consumer ----
  enqueued(): void {
    this.cEnqueued.inc();
    this.emit('notification.consumer.enqueued');
  }
  duplicate(): void {
    this.cDuplicate.inc();
    this.emit('notification.consumer.duplicate');
  }
  skipped(reason: string): void {
    this.cSkipped.inc({ reason });
    this.emit('notification.consumer.skipped', { reason });
  }
  consumerRetried(): void {
    this.cRetried.inc();
    this.emit('notification.consumer.retried');
  }
  deadLettered(reason: string): void {
    this.cDeadLettered.inc();
    this.emit('notification.consumer.dead_lettered', { reason });
  }
  consumerPaused(): void {
    this.cPause.inc();
    this.gConsumerPaused.set(1);
    this.emit('notification.consumer.paused');
  }
  consumerResumed(): void {
    this.gConsumerPaused.set(0);
    this.emit('notification.consumer.resumed');
  }

  // ---- sender ----
  claimed(count: number): void {
    this.sClaimed.inc(count);
    this.emit('notification.sender.claimed', { count });
  }
  sent(): void {
    this.sSent.inc();
    this.sResult.inc({ result: 'success' });
    this.emit('notification.sender.sent');
  }
  retried(): void {
    this.sRetried.inc();
    this.sResult.inc({ result: 'transient' });
    this.emit('notification.sender.retried');
  }
  failedPermanent(): void {
    this.sFailedPermanent.inc();
    this.sResult.inc({ result: 'permanent' });
    this.emit('notification.sender.failed_permanent');
  }
  failedExhausted(): void {
    this.sFailedExhausted.inc();
    this.sResult.inc({ result: 'transient' });
    this.emit('notification.sender.failed_exhausted');
  }
  senderPaused(): void {
    this.sBreakerTrip.inc();
    this.gBreakerOpen.set(1);
    this.emit('notification.sender.paused');
  }
  senderResumed(): void {
    this.gBreakerOpen.set(0);
    this.emit('notification.sender.resumed');
  }

  // ---- health (F5) ----
  health(scope: string, fields: { pending: number; failed: number; oldestPendingAgeMs: number }): void {
    if (scope === 'sender') {
      this.gBacklog.set(fields.pending);
      this.gFailedBacklog.set(fields.failed);
      this.gOldestAge.set(fields.oldestPendingAgeMs / 1000);
    }
    this.emit(`notification.${scope}.health`, fields);
  }
}
