import { MetricsRegistry } from '../../src/infrastructure/metrics/metrics.registry';
import { RelayMetrics } from '../../src/infrastructure/metrics/relay.metrics';
import { MetricsController } from '../../src/infrastructure/metrics/metrics.controller';
import { NotificationMetrics } from '../../src/infrastructure/notifications/notification.metrics';
import { LifecycleMetrics } from '../../src/infrastructure/lifecycle/lifecycle.metrics';

describe('MetricsRegistry', () => {
  let registry: MetricsRegistry;
  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  it('exposes build info with version/environment labels', async () => {
    const text = await registry.expose();
    expect(text).toContain('# TYPE masular_build_info gauge');
    expect(text).toMatch(/masular_build_info\{version="[^"]*",environment="[^"]*"\} 1/);
  });

  it('registers each metric name once (idempotent factory)', () => {
    const a = registry.counter('masular_test_total', 'help');
    const b = registry.counter('masular_test_total', 'help');
    expect(a).toBe(b);
  });

  it('increments counters', async () => {
    registry.counter('masular_test_total', 'help').inc(2);
    const text = await registry.expose();
    expect(text).toContain('# TYPE masular_test_total counter');
    expect(text).toMatch(/masular_test_total 2/);
  });

  it('updates gauges', async () => {
    registry.gauge('masular_test_gauge', 'help').set(42);
    const text = await registry.expose();
    expect(text).toMatch(/masular_test_gauge 42/);
  });

  it('observes histograms', async () => {
    const h = registry.histogram('masular_test_seconds', 'help', [0.05, 0.1, 1]);
    h.observe(0.05);
    const text = await registry.expose();
    expect(text).toContain('# TYPE masular_test_seconds histogram');
    expect(text).toMatch(/masular_test_seconds_bucket\{le="0.05"\} 1/);
    expect(text).toMatch(/masular_test_seconds_count 1/);
  });
});

describe('RelayMetrics', () => {
  let registry: MetricsRegistry;
  let metrics: RelayMetrics;
  beforeEach(() => {
    registry = new MetricsRegistry();
    metrics = new RelayMetrics(registry);
  });

  it('counts publishes and observes publish duration', async () => {
    metrics.publishedOk(0.05);
    const text = await registry.expose();
    expect(text).toMatch(/masular_relay_published_total 1/);
    expect(text).toMatch(/masular_relay_publish_duration_seconds_bucket\{le="0.05"\} 1/);
    expect(text).toMatch(/masular_relay_publish_duration_seconds_count 1/);
  });

  it('counts retries and terminal failures', async () => {
    metrics.retried();
    metrics.failedTerminal();
    const text = await registry.expose();
    expect(text).toMatch(/masular_relay_retry_total 1/);
    expect(text).toMatch(/masular_relay_failed_total 1/);
  });

  it('sets backlog/failed-backlog/oldest-age gauges from health', async () => {
    metrics.health({ pending: 7, failed: 2, oldestPendingAgeMs: 5_000 });
    const text = await registry.expose();
    expect(text).toMatch(/masular_relay_backlog 7/);
    expect(text).toMatch(/masular_relay_failed_backlog 2/);
    expect(text).toMatch(/masular_relay_oldest_pending_age_seconds 5/);
  });
});

describe('NotificationMetrics (backed)', () => {
  let registry: MetricsRegistry;
  let metrics: NotificationMetrics;
  beforeEach(() => {
    registry = new MetricsRegistry();
    metrics = new NotificationMetrics(registry);
  });

  it('classifies sender results (success/transient/permanent)', async () => {
    metrics.sent();
    metrics.retried();
    metrics.failedPermanent();
    const text = await registry.expose();
    expect(text).toMatch(/masular_notification_sender_sent_total 1/);
    expect(text).toMatch(/masular_notification_sender_result_total\{result="success"\} 1/);
    expect(text).toMatch(/masular_notification_sender_result_total\{result="transient"\} 1/);
    expect(text).toMatch(/masular_notification_sender_result_total\{result="permanent"\} 1/);
  });

  it('labels consumer skips by reason but not dead-letters (cardinality)', async () => {
    metrics.skipped('order_or_recipient_missing');
    metrics.deadLettered('some free-form error message');
    const text = await registry.expose();
    expect(text).toMatch(/masular_notification_consumer_skipped_total\{reason="order_or_recipient_missing"\} 1/);
    expect(text).toMatch(/masular_notification_consumer_dead_lettered_total 1/);
    expect(text).not.toContain('free-form error message');
  });

  it('tracks breaker state and sender backlog gauges', async () => {
    metrics.senderPaused();
    metrics.health('sender', { pending: 3, failed: 1, oldestPendingAgeMs: 5_000 });
    const text = await registry.expose();
    expect(text).toMatch(/masular_notification_sender_breaker_open 1/);
    expect(text).toMatch(/masular_notification_sender_breaker_trip_total 1/);
    expect(text).toMatch(/masular_notification_backlog 3/);
    expect(text).toMatch(/masular_notification_failed_backlog 1/);
    expect(text).toMatch(/masular_notification_sender_oldest_pending_age_seconds 5/);
  });
});

describe('LifecycleMetrics (backed)', () => {
  let registry: MetricsRegistry;
  let metrics: LifecycleMetrics;
  beforeEach(() => {
    registry = new MetricsRegistry();
    metrics = new LifecycleMetrics(registry);
  });

  it('counts deletions per table and stamps last-run', async () => {
    metrics.swept({ table: 'OutboxEvent.PUBLISHED', wouldDeleteCount: 0, deletedCount: 4, durationMs: 100, dryRun: false });
    const text = await registry.expose();
    expect(text).toMatch(/masular_retention_deleted_total\{table="OutboxEvent.PUBLISHED"\} 4/);
    expect(text).toMatch(/masular_retention_duration_seconds_count\{table="OutboxEvent.PUBLISHED"\} 1/);
    expect(text).toMatch(/masular_retention_last_run_timestamp_seconds [0-9]/);
  });

  it('counts redrive and DLQ redrive', async () => {
    metrics.redrive('outbox', 3);
    metrics.dlqRedrive(2);
    const text = await registry.expose();
    expect(text).toMatch(/masular_redrive_total\{type="outbox"\} 3/);
    expect(text).toMatch(/masular_dlq_redrive_total 2/);
  });
});

describe('MetricsController', () => {
  it('serves the Prometheus exposition text', async () => {
    const registry = new MetricsRegistry();
    registry.counter('masular_controller_test_total', 'help').inc();
    const controller = new MetricsController(registry);
    const text = await controller.scrape();
    expect(text).toContain('masular_build_info');
    expect(text).toMatch(/masular_controller_test_total 1/);
  });
});
