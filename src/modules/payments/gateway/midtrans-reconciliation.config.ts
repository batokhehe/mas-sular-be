import { positiveInt } from '../../../common/utils/number.util';

export const MIDTRANS_RECONCILIATION_CONFIG = 'MIDTRANS_RECONCILIATION_CONFIG';

export interface MidtransReconciliationConfig {
  /** Master switch. Defaults to false; enable via MIDTRANS_RECONCILIATION_ENABLED=true. */
  enabled: boolean;
  pollIntervalMs: number;
  initialDelayMs: number;
  batchSize: number;
  /**
   * Minimum age before a gateway transaction is reconciled.
   *
   * This is NOT a business expiry window — the payment lifecycle worker already owns
   * that (PAYMENT_EXPIRY_AFTER_MS / PAYMENT_GATEWAY_EXPIRY_AFTER_MS) and nothing here
   * duplicates it. It exists only so reconciliation cannot race the charge request
   * that created the row, or a webhook still in flight. Default mirrors
   * SHIPMENT_RECONCILIATION_DELAY_MS (2 minutes), the repository's existing grace
   * period for exactly this "did the in-flight path finish?" question.
   */
  minAgeMs: number;
  healthLogIntervalMs: number;
}

export function loadMidtransReconciliationConfig(
  env: NodeJS.ProcessEnv = process.env,
): MidtransReconciliationConfig {
  return {
    enabled: env.MIDTRANS_RECONCILIATION_ENABLED === 'true',
    pollIntervalMs: positiveInt(env.MIDTRANS_RECONCILIATION_INTERVAL_MS, 60_000),
    initialDelayMs: positiveInt(env.MIDTRANS_RECONCILIATION_INITIAL_DELAY_MS, 30_000),
    batchSize: positiveInt(env.MIDTRANS_RECONCILIATION_BATCH_SIZE, 50),
    minAgeMs: positiveInt(env.MIDTRANS_RECONCILIATION_MIN_AGE_MS, 2 * 60_000),
    healthLogIntervalMs: positiveInt(env.MIDTRANS_RECONCILIATION_HEALTH_LOG_MS, 5 * 60_000),
  };
}
