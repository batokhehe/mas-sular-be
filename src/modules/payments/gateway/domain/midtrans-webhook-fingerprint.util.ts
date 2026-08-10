import { createHash } from 'crypto';

/**
 * Deterministic identity of a Midtrans notification (Phase 5C).
 *
 * PURE — no I/O, no DB, no logging.
 *
 * WHY NOT THE RAW BODY: Midtrans adds channel-specific and future fields, and JSON
 * key order is not stable across retries. Hashing the body would make a redelivery
 * of the *same* event look new, and idempotency would silently stop working.
 *
 * WHY NOT `signature_key` ALONE: the signature covers only order_id + status_code +
 * gross_amount. A card charge emits `capture` then `settlement` with the SAME
 * status_code (200) and the same amount, so both notifications carry an IDENTICAL
 * signature_key. Using it as the event id would classify the settlement as a
 * duplicate and drop it — the exact failure this phase exists to prevent. It is also
 * a secret-derived value, and it adds zero entropy beyond the three fields it is
 * computed from, so it is excluded from the fingerprint entirely.
 *
 * THE FIELDS, and what each one distinguishes:
 *   order_id           the attempt (Phase 5A: `{orderNumber}-{attemptId8}`)
 *   transaction_id     the provider's transaction, distinguishing re-charges
 *   status_code        pending (201) vs settled (200) vs denied (202)
 *   transaction_status the gateway state word itself
 *   fraud_status       `capture`+challenge and `capture`+accept are DIFFERENT states
 *                      that share every other field; without this the accept is lost
 *   gross_amount       verbatim, exactly as signed — never normalized
 *
 * ENCODING: fields are JSON-array encoded before hashing, not colon-joined. A
 * delimiter join is ambiguous when a value can contain the delimiter — order_id
 * "A:B" + transaction_id "C" would join identically to "A" + "B:C", and a collision
 * here means a DROPPED notification. JSON escaping removes that class of bug, and
 * positional encoding keeps the representation canonical regardless of key order.
 */

/** Bump when the field set changes: old and new fingerprints must never collide. */
export const MIDTRANS_FINGERPRINT_VERSION = 'v1';

export interface MidtransNotificationIdentity {
  orderId: string;
  transactionId?: string | null;
  statusCode: string;
  transactionStatus?: string | null;
  fraudStatus?: string | null;
  /** VERBATIM string from the notification — never parsed, never normalized. */
  grossAmount: string;
}

/** Canonical, human-readable pre-image. Exposed so tests can assert it directly. */
export function midtransNotificationCanonical(id: MidtransNotificationIdentity): string {
  // `?? null` so an absent field and an explicitly-null field are one identity.
  const fields = [
    id.orderId,
    id.transactionId ?? null,
    id.statusCode,
    id.transactionStatus ?? null,
    id.fraudStatus ?? null,
    id.grossAmount,
  ];
  return `midtrans:${MIDTRANS_FINGERPRINT_VERSION}:${JSON.stringify(fields)}`;
}

/** SHA-256 hex (64 chars) of the canonical identity — the unique dedup key. */
export function midtransWebhookFingerprint(id: MidtransNotificationIdentity): string {
  return createHash('sha256').update(midtransNotificationCanonical(id)).digest('hex');
}

/** Midtrans emits `YYYY-MM-DD HH:mm:ss` (WIB, no offset marker) and nothing else. */
const MIDTRANS_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/**
 * Event time used to reject an unambiguously older notification.
 *
 * `settlement_time` first, then `transaction_time`: transaction_time is the time the
 * transaction was CREATED and is therefore identical on every notification for one
 * order, which carries no ordering information at all. settlement_time only appears
 * once the money moves, so a stale `pending` arriving after a `settlement` compares
 * strictly older and is correctly refused.
 *
 * The value is read as if it were UTC. That is deliberately NOT a timezone
 * conversion: these timestamps are only ever compared to each other, and a constant
 * offset preserves ordering. Anything not matching the exact format yields null,
 * which DISABLES the guard rather than risking a wrong comparison — refusing to
 * order is safe, mis-ordering is not.
 */
export function parseMidtransNotificationTime(input: {
  settlement_time?: string | null;
  transaction_time?: string | null;
}): Date | null {
  const raw = input.settlement_time ?? input.transaction_time;
  if (!raw) return null;

  const m = MIDTRANS_TIME.exec(raw.trim());
  if (!m) return null;

  const [, y, mo, d, h, mi, s] = m;
  const ts = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (Number.isNaN(ts)) return null;

  // Date.UTC rolls over out-of-range parts (month 13 → next year); reject instead of
  // silently accepting a fabricated instant.
  const date = new Date(ts);
  if (date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return null;

  return date;
}
