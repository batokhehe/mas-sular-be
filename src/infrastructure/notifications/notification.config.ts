import { positiveInt } from '../../common/utils/number.util';
export const NOTIFICATION_SENDER_CONFIG = 'NOTIFICATION_SENDER_CONFIG';

export interface NotificationSenderConfig {
  /** Master switch. Defaults to false; enable via NOTIFICATION_SENDER_ENABLED=true. */
  enabled: boolean;
  /** Max rows claimed and sent per tick. */
  batchSize: number;
  /** Claim lease duration; a crashed sender's rows become reclaimable after this. */
  leaseMs: number;
  /** Idle poll cadence. */
  pollIntervalMs: number;
  /** Exponential backoff base for transient send failures. */
  backoffBaseMs: number;
  /** Exponential backoff ceiling. */
  backoffCapMs: number;
  /** Transient attempts after which a row becomes terminally FAILED. */
  maxAttempts: number;
  /** Throttle for health logging. */
  healthLogIntervalMs: number;
  /** Consecutive transient failures that trip the breaker (pause). */
  breakerThreshold: number;
  /** How long the breaker stays open (sends paused) after tripping. */
  pauseMs: number;

  /** Resend API key (secret). Required when enabled. */
  emailApiKey?: string;
  /** Verified sender address. Required when enabled. */
  emailFrom?: string;
  /** Provider HTTP request timeout; must be < leaseMs so a hung call can't outlive the lease. */
  emailRequestTimeoutMs: number;
}

export function loadNotificationSenderConfig(env: NodeJS.ProcessEnv = process.env): NotificationSenderConfig {
  const leaseMs = positiveInt(env.NOTIFICATION_SENDER_LEASE_MS, 30_000);
  const emailRequestTimeoutMs = positiveInt(env.EMAIL_REQUEST_TIMEOUT_MS, 10_000);
  const config: NotificationSenderConfig = {
    enabled: env.NOTIFICATION_SENDER_ENABLED === 'true',
    batchSize: positiveInt(env.NOTIFICATION_SENDER_BATCH_SIZE, 50),
    leaseMs,
    pollIntervalMs: positiveInt(env.NOTIFICATION_SENDER_POLL_INTERVAL_MS, 1_000),
    backoffBaseMs: positiveInt(env.NOTIFICATION_SENDER_BACKOFF_BASE_MS, 5_000),
    backoffCapMs: positiveInt(env.NOTIFICATION_SENDER_BACKOFF_CAP_MS, 3_600_000),
    maxAttempts: positiveInt(env.NOTIFICATION_SENDER_MAX_ATTEMPTS, 8),
    healthLogIntervalMs: positiveInt(env.NOTIFICATION_SENDER_HEALTH_LOG_INTERVAL_MS, 60_000),
    breakerThreshold: positiveInt(env.NOTIFICATION_SENDER_BREAKER_THRESHOLD, 5),
    pauseMs: positiveInt(env.NOTIFICATION_SENDER_PAUSE_MS, 30_000),
    emailApiKey: env.RESEND_API_KEY,
    emailFrom: env.EMAIL_FROM,
    emailRequestTimeoutMs,
  };

  // Fail fast: the sender cannot deliver without provider credentials, and a request
  // timeout >= the lease could let a hung call outlive the lease (concurrent re-send).
  if (config.enabled) {
    if (!config.emailApiKey || !config.emailFrom) {
      throw new Error('NOTIFICATION_SENDER_ENABLED=true requires RESEND_API_KEY and EMAIL_FROM');
    }
    if (emailRequestTimeoutMs >= leaseMs) {
      throw new Error('EMAIL_REQUEST_TIMEOUT_MS must be < NOTIFICATION_SENDER_LEASE_MS');
    }
  }

  return config;
}
