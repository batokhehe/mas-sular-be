import { createHash } from 'crypto';
import { constantTimeEqual } from '../../../../common/auth/csrf.util';

/**
 * Midtrans notification signature (Phase 5B).
 *
 * PURE — no I/O, no DB, no logging. The only thing that authenticates an inbound
 * notification: there is no JWT, no admin guard, and deliberately no trusted-IP
 * bypass, because an IP allowlist is spoofable and would weaken this boundary.
 *
 *   signature_key = SHA512(order_id + status_code + gross_amount + ServerKey)
 *
 * `gross_amount` MUST participate exactly as received ("130000.00"). Parsing it
 * to a number first ("130000") produces a different digest and would reject
 * every legitimate notification — see the decimal test.
 */
export interface MidtransSignatureInput {
  orderId: string;
  statusCode: string;
  /** VERBATIM string from the notification — never normalized, never parsed. */
  grossAmount: string;
}

/** Compute the expected signature. Returned as lowercase hex, as Midtrans sends it. */
export function buildMidtransSignature(input: MidtransSignatureInput, serverKey: string): string {
  return createHash('sha512')
    .update(`${input.orderId}${input.statusCode}${input.grossAmount}${serverKey}`)
    .digest('hex');
}

/**
 * Constant-time verification. Reuses the shared `constantTimeEqual` (Node's
 * `timingSafeEqual` with a length guard) so a wrong signature leaks no timing
 * information. Never returns or logs the expected value — a caller cannot use
 * this to discover a valid signature.
 */
export function verifyMidtransSignature(
  input: MidtransSignatureInput,
  serverKey: string | undefined,
  receivedSignature: string | undefined,
): boolean {
  if (!serverKey || !receivedSignature) return false;
  return constantTimeEqual(buildMidtransSignature(input, serverKey), receivedSignature);
}
