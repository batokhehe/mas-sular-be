import { createHash } from 'crypto';

/**
 * Paxel request signing (`X-Paxel-Signature`).
 *
 * Three different formulas, one per operation — they are NOT interchangeable.
 * Each is transcribed from the `X-Paxel-Signature` header documentation in the
 * Paxel eCommerce API Postman collection, and each of the collection's worked
 * examples is pinned as a test vector in paxel-signature.spec.ts. If a formula
 * is ever "tidied" (trimming, lower-casing, reordering), those vectors fail.
 *
 * Note the asymmetry, which is easy to get wrong: create takes the FIRST two
 * characters of four fields, while cancel and webhook take the LAST six of the
 * airwaybill plus the first two of one other field. Paxel does not normalise
 * the inputs, so neither do we — the substrings are taken verbatim.
 *
 * The secret is only ever an input to the hash. It is never returned, never
 * logged, and never embedded in an error message; callers get the digest alone.
 */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface PaxelCreateSignatureInput {
  invoiceNumber: string;
  originName: string;
  destinationName: string;
  /** Name of the FIRST item in the request, in the order sent to Paxel. */
  firstItemName: string;
}

/**
 * POST /shipments
 *
 * SHA256(invoice_number[:2] + origin.name[:2] + destination.name[:2] + items[0].name[:2] + secret)
 */
export function paxelCreateSignature(input: PaxelCreateSignatureInput, secret: string): string {
  return sha256Hex(
    input.invoiceNumber.slice(0, 2) +
      input.originName.slice(0, 2) +
      input.destinationName.slice(0, 2) +
      input.firstItemName.slice(0, 2) +
      secret,
  );
}

/**
 * POST /shipments/:airwaybill_code/cancel
 *
 * SHA256(airwaybill_code[-6:] + cancellation_reason[:2] + secret)
 */
export function paxelCancelSignature(airwaybillCode: string, cancellationReason: string, secret: string): string {
  return sha256Hex(airwaybillCode.slice(-6) + cancellationReason.slice(0, 2) + secret);
}

/**
 * Inbound webhook verification.
 *
 * SHA256(airwaybill_code[-6:] + latest_status[:2] + secret)
 *
 * Provided now because it belongs with its two siblings and is verified by the
 * same collection example. Nothing consumes it yet: the webhook endpoint,
 * routing and processing are deliberately out of scope until a later phase.
 */
export function paxelWebhookSignature(airwaybillCode: string, latestStatus: string, secret: string): string {
  return sha256Hex(airwaybillCode.slice(-6) + latestStatus.slice(0, 2) + secret);
}
