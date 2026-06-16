export const PAYMENT_LIFECYCLE_CONFIG = 'PAYMENT_LIFECYCLE_CONFIG';

export interface PaymentLifecycleConfig {
  /** Master switch. Defaults to false; enable via PAYMENT_LIFECYCLE_ENABLED=true. */
  enabled: boolean;
  pollIntervalMs: number;
  initialDelayMs: number;
  batchSize: number;
  /** 1st reminder, measured from payment.createdAt (checkout). Default 12h. */
  firstReminderAfterMs: number;
  /** 2nd reminder. Default 20h. */
  secondReminderAfterMs: number;
  /** BANK_TRANSFER / QRIS expiry window. Default 24h. */
  expiryAfterMs: number;
  /** GATEWAY expiry window; 0 disables gateway expiry (treated as never). */
  gatewayExpiryAfterMs: number;
}

const HOUR = 60 * 60 * 1000;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

export function loadPaymentLifecycleConfig(env: NodeJS.ProcessEnv = process.env): PaymentLifecycleConfig {
  return {
    enabled: env.PAYMENT_LIFECYCLE_ENABLED === 'true',
    pollIntervalMs: positiveInt(env.PAYMENT_LIFECYCLE_POLL_MS, 5 * 60 * 1000),
    initialDelayMs: positiveInt(env.PAYMENT_LIFECYCLE_INITIAL_DELAY_MS, 60 * 1000),
    batchSize: positiveInt(env.PAYMENT_LIFECYCLE_BATCH_SIZE, 100),
    firstReminderAfterMs: positiveInt(env.PAYMENT_FIRST_REMINDER_MS, 12 * HOUR),
    secondReminderAfterMs: positiveInt(env.PAYMENT_SECOND_REMINDER_MS, 20 * HOUR),
    expiryAfterMs: positiveInt(env.PAYMENT_EXPIRY_MS, 24 * HOUR),
    gatewayExpiryAfterMs: nonNegativeInt(env.PAYMENT_GATEWAY_EXPIRY_MS, 24 * HOUR),
  };
}
