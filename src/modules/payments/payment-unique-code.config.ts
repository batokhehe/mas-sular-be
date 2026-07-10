import { finiteInt as intOr } from '../../common/utils/number.util';
export const PAYMENT_UNIQUE_CODE_CONFIG = 'PAYMENT_UNIQUE_CODE_CONFIG';

export interface PaymentUniqueCodeConfig {
  /** Master switch. When false, checkout behaves exactly like before (no code). */
  enabled: boolean;
  /** Inclusive lower bound for the random code. */
  min: number;
  /** Inclusive upper bound for the random code. */
  max: number;
  /** How many random draws to try before giving up on a collision-free code. */
  maxAttempts: number;
}

/** The absolute ceiling for a 3-digit code (spec: max <= 999). */
const CODE_CEILING = 999;

/**
 * Load + validate the unique-code config. Range invariants (min >= 0, max <= 999,
 * max > min) fail fast at startup so a misconfiguration never reaches checkout.
 */
export function loadPaymentUniqueCodeConfig(env: NodeJS.ProcessEnv = process.env): PaymentUniqueCodeConfig {
  const enabled = env.PAYMENT_UNIQUE_CODE_ENABLED === 'true';
  const min = intOr(env.PAYMENT_UNIQUE_CODE_MIN, 100);
  const max = intOr(env.PAYMENT_UNIQUE_CODE_MAX, 999);
  const maxAttempts = Math.max(1, intOr(env.PAYMENT_UNIQUE_CODE_MAX_ATTEMPTS, 10));

  if (min < 0) throw new Error('PAYMENT_UNIQUE_CODE_MIN must be >= 0');
  if (max > CODE_CEILING) throw new Error('PAYMENT_UNIQUE_CODE_MAX must be <= 999');
  if (!(max > min)) throw new Error('PAYMENT_UNIQUE_CODE_MAX must be greater than PAYMENT_UNIQUE_CODE_MIN');

  return { enabled, min, max, maxAttempts };
}
