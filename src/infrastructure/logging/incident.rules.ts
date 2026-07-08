import { IncidentSeverity } from '@prisma/client';

/**
 * PURE incident detection rules. The service gathers `IncidentSignals` from
 * existing data (SystemLog, queue tables, Redis ping, DB timing registry) and
 * this module decides WHICH incidents exist and HOW severe they are. No I/O.
 */

export interface IncidentThresholds {
  errorRatePct: number; // request error rate (last hour)
  queuePending: number; // outbox/notification pending backlog
  workerFailures: number; // failures in the window with no success after
  notificationFailures: number;
  checkoutP95Ms: number;
  dbLatencyMs: number; // avg per query name
}

function intOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

export function loadIncidentThresholds(env: NodeJS.ProcessEnv = process.env): IncidentThresholds {
  return {
    errorRatePct: intOr(env.INCIDENT_ERROR_RATE_PCT, 5),
    queuePending: intOr(env.INCIDENT_QUEUE_PENDING, 100),
    workerFailures: intOr(env.INCIDENT_WORKER_FAILURES, 3),
    notificationFailures: intOr(env.INCIDENT_NOTIFICATION_FAILURES, 5),
    checkoutP95Ms: intOr(env.INCIDENT_CHECKOUT_P95_MS, 3000),
    dbLatencyMs: intOr(env.INCIDENT_DB_LATENCY_MS, 200),
  };
}

export interface IncidentSignals {
  /** Last-hour request stats from SystemLog (module='http'). */
  requests: { count: number; errors: number };
  /** Per-worker last-hour tick stats. */
  workers: Array<{ key: string; failures: number; lastFailure: string | null; lastSuccess: string | null }>;
  /** Queue backlogs. */
  outbox: { pending: number; failed: number; oldestPendingAgeMs: number | null };
  notifications: { pending: number; failed: number };
  redisConnected: boolean;
  rabbitConfigured: boolean;
  /** Checkout POST p95 over the last hour (0 when no traffic). */
  checkoutP95Ms: number;
  /** Worst DB query by average (from the in-memory registry). */
  dbWorst: { name: string; avgMs: number; count: number } | null;
}

export interface IncidentCandidate {
  type: string; // dedup key while OPEN/ACKNOWLEDGED
  severity: IncidentSeverity;
  title: string;
  description: string;
  source: string;
  worker?: string | null;
  module?: string | null;
  metadata?: Record<string, unknown>;
}

// Outbox pending older than this with the broker configured → delivery is stalled.
const OUTBOX_STALL_MS = 10 * 60 * 1000;

/** Evaluate every rule; returns the incidents that are CURRENTLY firing. */
export function evaluateRules(signals: IncidentSignals, t: IncidentThresholds): IncidentCandidate[] {
  const candidates: IncidentCandidate[] = [];

  // 1. Request error rate.
  if (signals.requests.count >= 10) {
    const rate = (signals.requests.errors / signals.requests.count) * 100;
    if (rate >= t.errorRatePct) {
      candidates.push({
        type: 'error-rate',
        severity: rate >= t.errorRatePct * 2 ? IncidentSeverity.CRITICAL : IncidentSeverity.HIGH,
        title: `Error rate ${Math.round(rate * 10) / 10}% over the last hour`,
        description: `${signals.requests.errors} of ${signals.requests.count} requests failed (threshold ${t.errorRatePct}%).`,
        source: 'system-log',
        module: 'http',
        metadata: { ratePct: Math.round(rate * 10) / 10, errors: signals.requests.errors, requests: signals.requests.count },
      });
    }
  }

  // 2. Workers failing consecutively (failures present and nothing succeeded after).
  for (const w of signals.workers) {
    const failingAfterSuccess = !!w.lastFailure && (!w.lastSuccess || w.lastFailure > w.lastSuccess);
    if (w.failures >= t.workerFailures && failingAfterSuccess) {
      candidates.push({
        type: `worker-failing:${w.key}`,
        severity: w.failures >= t.workerFailures * 3 ? IncidentSeverity.CRITICAL : IncidentSeverity.HIGH,
        title: `Worker ${w.key} is failing`,
        description: `${w.failures} failed executions in the last hour with no success since.`,
        source: 'worker',
        worker: w.key,
        module: `worker.${w.key}`,
        metadata: { failures: w.failures, lastFailure: w.lastFailure, lastSuccess: w.lastSuccess },
      });
    }
  }

  // 3. Queue pending backlog.
  if (signals.outbox.pending >= t.queuePending) {
    candidates.push({
      type: 'queue-pending:outbox',
      severity: signals.outbox.pending >= t.queuePending * 10 ? IncidentSeverity.HIGH : IncidentSeverity.MEDIUM,
      title: `Outbox backlog: ${signals.outbox.pending} pending events`,
      description: `Outbox pending exceeds the threshold of ${t.queuePending}.`,
      source: 'queue',
      metadata: { pending: signals.outbox.pending },
    });
  }
  if (signals.notifications.pending >= t.queuePending) {
    candidates.push({
      type: 'queue-pending:notifications',
      severity: signals.notifications.pending >= t.queuePending * 10 ? IncidentSeverity.HIGH : IncidentSeverity.MEDIUM,
      title: `Notification backlog: ${signals.notifications.pending} pending`,
      description: `Notification queue pending exceeds the threshold of ${t.queuePending}.`,
      source: 'queue',
      metadata: { pending: signals.notifications.pending },
    });
  }

  // 4. Notification delivery failures.
  if (signals.notifications.failed >= t.notificationFailures) {
    candidates.push({
      type: 'notification-failures',
      severity: signals.notifications.failed >= t.notificationFailures * 4 ? IncidentSeverity.HIGH : IncidentSeverity.MEDIUM,
      title: `${signals.notifications.failed} notifications permanently failed`,
      description: 'Failed notifications require manual retry from the Queue Center.',
      source: 'queue',
      metadata: { failed: signals.notifications.failed },
    });
  }

  // 5. Redis unavailable.
  if (!signals.redisConnected) {
    candidates.push({
      type: 'redis-down',
      severity: IncidentSeverity.CRITICAL,
      title: 'Redis is unreachable',
      description: 'Cache ping failed — sessions/caching degraded.',
      source: 'cache',
    });
  }

  // 6. Broker/relay stalled: configured, backlog present, oldest pending too old.
  if (
    signals.rabbitConfigured &&
    signals.outbox.pending > 0 &&
    signals.outbox.oldestPendingAgeMs != null &&
    signals.outbox.oldestPendingAgeMs >= OUTBOX_STALL_MS
  ) {
    candidates.push({
      type: 'outbox-stalled',
      severity: IncidentSeverity.CRITICAL,
      title: 'Outbox delivery is stalled',
      description: 'Pending events are not being published (RabbitMQ or the relay may be down).',
      source: 'broker',
      metadata: { oldestPendingAgeMs: signals.outbox.oldestPendingAgeMs, pending: signals.outbox.pending },
    });
  }

  // 7. Checkout latency.
  if (signals.checkoutP95Ms >= t.checkoutP95Ms) {
    candidates.push({
      type: 'checkout-p95',
      severity: signals.checkoutP95Ms >= t.checkoutP95Ms * 2 ? IncidentSeverity.CRITICAL : IncidentSeverity.HIGH,
      title: `Checkout p95 is ${signals.checkoutP95Ms}ms`,
      description: `Checkout p95 exceeds the ${t.checkoutP95Ms}ms threshold.`,
      source: 'performance',
      module: 'http',
      metadata: { p95Ms: signals.checkoutP95Ms },
    });
  }

  // 8. Database latency (worst query by average, with enough samples to matter).
  if (signals.dbWorst && signals.dbWorst.count >= 10 && signals.dbWorst.avgMs >= t.dbLatencyMs) {
    candidates.push({
      type: `db-latency:${signals.dbWorst.name}`,
      severity: signals.dbWorst.avgMs >= t.dbLatencyMs * 5 ? IncidentSeverity.HIGH : IncidentSeverity.MEDIUM,
      title: `Slow database query: ${signals.dbWorst.name}`,
      description: `Average ${signals.dbWorst.avgMs}ms over ${signals.dbWorst.count} calls (threshold ${t.dbLatencyMs}ms).`,
      source: 'performance',
      metadata: { ...signals.dbWorst },
    });
  }

  return candidates;
}
