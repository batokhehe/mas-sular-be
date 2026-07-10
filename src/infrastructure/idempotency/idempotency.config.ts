import { positiveInt } from '../../common/utils/number.util';
export const IDEMPOTENCY_CONFIG = 'IDEMPOTENCY_CONFIG';

export type ReplayMode = 'snapshot' | 'rehydrate';

export interface IdempotencyConfig {
  /** Gate for checkout idempotency. Defaults to false (Phase A optional rollout). */
  checkoutEnabled: boolean;
  /** Phase B: when true, POST /checkout/order rejects a missing key with 400. */
  checkoutRequired: boolean;
  /**
   * How a COMPLETED replay returns its body:
   *  - 'snapshot'  : return the stored responseBody as-is (creation-time view).
   *  - 'rehydrate' : re-read the resource by resourceId and return current state.
   * Defaults to 'snapshot'.
   */
  replayMode: ReplayMode;
  /** How long a key (and its replayable response) is retained. */
  retentionMs: number;
  /** A PROCESSING row older than this is treated as abandoned and reclaimable. */
  reclaimMs: number;
  /** Retry-After value (seconds) returned for an in-progress (PROCESSING) request. */
  retryAfterSeconds: number;
}

export function loadIdempotencyConfig(env: NodeJS.ProcessEnv = process.env): IdempotencyConfig {
  const checkoutEnabled = env.CHECKOUT_IDEMPOTENCY_ENABLED === 'true';
  const checkoutRequired = env.CHECKOUT_IDEMPOTENCY_REQUIRED === 'true';

  // Requiring a key without the machinery engaged would 400 every checkout —
  // fail fast at startup rather than break checkout in production.
  if (checkoutRequired && !checkoutEnabled) {
    throw new Error(
      'CHECKOUT_IDEMPOTENCY_REQUIRED=true requires CHECKOUT_IDEMPOTENCY_ENABLED=true',
    );
  }

  return {
    checkoutEnabled,
    checkoutRequired,
    replayMode: env.IDEMPOTENCY_REPLAY_MODE === 'rehydrate' ? 'rehydrate' : 'snapshot',
    retentionMs: positiveInt(env.IDEMPOTENCY_RETENTION_MS, 48 * 60 * 60 * 1000), // 48h
    reclaimMs: positiveInt(env.IDEMPOTENCY_RECLAIM_MS, 120 * 1000), // 120s
    retryAfterSeconds: positiveInt(env.IDEMPOTENCY_RETRY_AFTER_SECONDS, 2),
  };
}
