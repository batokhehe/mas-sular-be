import { GatewayTransactionStatus, PaymentStatus } from '@prisma/client';
import { mapGatewayStatusToPaymentStatus } from './gateway-status.mapper';
import { mapMidtransStatus } from '../infrastructure/providers/midtrans-payment.provider';

/**
 * Validation of the AUTHORITATIVE Midtrans Status API response (Phase 5D §17).
 *
 * PURE — no I/O. The webhook body cannot be trusted for the settlement decision
 * (its signature covers only order_id, status_code and gross_amount — not
 * transaction_status, fraud_status or transaction_id), so money moves only on what
 * this function certifies about a response fetched over the server-key-authenticated
 * Status API.
 *
 * Nothing here is a new mapping: the status vocabulary goes through the existing
 * `mapMidtransStatus` → `mapGatewayStatusToPaymentStatus` chain, which already
 * encodes that capture+challenge is AUTHORIZED (not paid) and capture+deny FAILED.
 */

export interface MidtransStatusFacts {
  orderId: string;
  transactionStatus: string;
  statusCode: string;
  grossAmount: string;
  transactionId: string | null;
  fraudStatus: string | null;
}

export type StatusVerificationFailure =
  /** Required fields absent or not strings — never guess, never settle. */
  | 'malformed_response'
  /** The response describes a DIFFERENT order than the one we correlated. */
  | 'order_id_mismatch'
  /** The amount the gateway reports is not the amount we are owed. */
  | 'amount_mismatch';

export type StatusVerification =
  | {
      ok: true;
      facts: MidtransStatusFacts;
      gatewayStatus: GatewayTransactionStatus;
      /** What the existing state machine says this means for the business payment. */
      paymentStatus: PaymentStatus;
    }
  | { ok: false; reason: StatusVerificationFailure };

/** Rupiah, optionally with a decimal part — Midtrans sends "40000.00". */
const AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Midtrans amounts are whole rupiah; the decimal part exists only for formatting.
 * Returns null when the string is not a clean amount or carries actual sub-rupiah
 * precision, so a malformed amount can never compare equal by rounding.
 */
export function parseMidtransAmountToRupiah(raw: string): number | null {
  const m = AMOUNT.exec(raw.trim());
  if (!m) return null;
  if (m[2] && Number(m[2].padEnd(2, '0')) !== 0) return null; // real fractional value
  const rupiah = Number(m[1]);
  return Number.isSafeInteger(rupiah) ? rupiah : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Certify a Status API response against what we already know.
 *
 * @param raw            the provider response body (unknown — never trusted as-is)
 * @param expectedOrderId the providerOrderId we correlated in Phase 5A/5C
 * @param expectedAmount  gross amount in whole rupiah from the gateway ledger
 */
export function verifyMidtransStatusResponse(
  raw: unknown,
  expectedOrderId: string,
  expectedAmount: number,
): StatusVerification {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'malformed_response' };
  const body = raw as Record<string, unknown>;

  const orderId = str(body.order_id);
  const transactionStatus = str(body.transaction_status);
  const statusCode = str(body.status_code);
  const grossAmount = str(body.gross_amount);
  // transaction_id is required by §17 but Midtrans omits it for a never-charged
  // order; treat an absent id as malformed only when the status claims money moved.
  const transactionId = str(body.transaction_id);

  if (!orderId || !transactionStatus || !statusCode || !grossAmount) {
    return { ok: false, reason: 'malformed_response' };
  }

  // The response must describe the order we asked about. Guards against a proxy or
  // a mis-keyed lookup settling the wrong payment.
  if (orderId !== expectedOrderId) return { ok: false, reason: 'order_id_mismatch' };

  const rupiah = parseMidtransAmountToRupiah(grossAmount);
  if (rupiah === null) return { ok: false, reason: 'malformed_response' };
  if (rupiah !== expectedAmount) return { ok: false, reason: 'amount_mismatch' };

  const fraudStatus = str(body.fraud_status);
  const gatewayStatus = mapMidtransStatus(transactionStatus, fraudStatus ?? undefined);
  const paymentStatus = mapGatewayStatusToPaymentStatus(gatewayStatus);

  // Claiming settled money without a transaction id is not a response we will act on.
  if (paymentStatus === PaymentStatus.PAID && !transactionId) {
    return { ok: false, reason: 'malformed_response' };
  }

  return {
    ok: true,
    facts: { orderId, transactionStatus, statusCode, grossAmount, transactionId, fraudStatus },
    gatewayStatus,
    paymentStatus,
  };
}
