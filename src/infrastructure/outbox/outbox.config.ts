export const OUTBOX_CONFIG = 'OUTBOX_CONFIG';

export interface OutboxRelayConfig {
  /** Master switch. Defaults to false; enable explicitly via OUTBOX_RELAY_ENABLED=true. */
  enabled: boolean;
  /** Broker URL. When absent the relay stays idle (mirrors EventBus behavior). */
  rabbitmqUrl?: string;
  /** Idle poll cadence; a full batch drains immediately regardless. */
  pollIntervalMs: number;
  /** Max rows claimed and published per tick. */
  batchSize: number;
  /** Claim lease duration; a crashed worker's rows become reclaimable after this. */
  leaseMs: number;
  /** Exponential backoff base for failed publishes. */
  backoffBaseMs: number;
  /** Exponential backoff ceiling. */
  backoffCapMs: number;
  /** Throttle for relay health logging (pending/failed/oldest age). */
  healthLogIntervalMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function loadOutboxConfig(env: NodeJS.ProcessEnv = process.env): OutboxRelayConfig {
  return {
    enabled: env.OUTBOX_RELAY_ENABLED === 'true',
    rabbitmqUrl: env.RABBITMQ_URL,
    pollIntervalMs: positiveInt(env.OUTBOX_POLL_INTERVAL_MS, 1000),
    batchSize: positiveInt(env.OUTBOX_BATCH_SIZE, 50),
    leaseMs: positiveInt(env.OUTBOX_LEASE_MS, 30_000),
    backoffBaseMs: positiveInt(env.OUTBOX_BACKOFF_BASE_MS, 5_000),
    backoffCapMs: positiveInt(env.OUTBOX_BACKOFF_CAP_MS, 3_600_000),
    healthLogIntervalMs: positiveInt(env.OUTBOX_HEALTH_LOG_INTERVAL_MS, 60_000),
  };
}
