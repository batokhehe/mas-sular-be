import { GatewayTransactionStatus, PaymentStatus } from '@prisma/client';

/**
 * The ONE place provider vocabulary becomes business vocabulary.
 *
 * PREPARED, NOT WIRED (Phase 2): no caller invokes this yet. The status-changing
 * flows (webhook receiver, status sync) arrive in Phase 4 and will route through
 * here so that a gateway can never write a PaymentStatus directly.
 *
 * Pure function — no I/O, no side effects, exhaustive over the enum.
 */
export function mapGatewayStatusToPaymentStatus(status: GatewayTransactionStatus): PaymentStatus {
  switch (status) {
    // Money is not ours yet: the charge is open and awaiting the customer.
    case GatewayTransactionStatus.PENDING:
      return PaymentStatus.PENDING;
    // Authorized (card hold) is NOT settled money — it still needs capture, so it
    // must not flip an order into PROCESSING. Deliberately mapped to PENDING.
    case GatewayTransactionStatus.AUTHORIZED:
      return PaymentStatus.PENDING;
    // Funds captured/settled — the only states that mean "paid".
    case GatewayTransactionStatus.CAPTURED:
    case GatewayTransactionStatus.SETTLEMENT:
      return PaymentStatus.PAID;
    case GatewayTransactionStatus.FAILED:
      return PaymentStatus.FAILED;
    case GatewayTransactionStatus.EXPIRED:
      return PaymentStatus.EXPIRED;
    // A cancelled charge is a terminal non-payment; the business vocabulary has no
    // CANCELLED payment state, and FAILED is what the existing reject flow uses.
    case GatewayTransactionStatus.CANCELLED:
      return PaymentStatus.FAILED;
    case GatewayTransactionStatus.REFUNDED:
      return PaymentStatus.REFUNDED;
  }
}

/** Gateway statuses after which no further provider callback should move the row. */
export const TERMINAL_GATEWAY_STATUSES: readonly GatewayTransactionStatus[] = [
  GatewayTransactionStatus.SETTLEMENT,
  GatewayTransactionStatus.CAPTURED,
  GatewayTransactionStatus.FAILED,
  GatewayTransactionStatus.EXPIRED,
  GatewayTransactionStatus.CANCELLED,
  GatewayTransactionStatus.REFUNDED,
];

export function isTerminalGatewayStatus(status: GatewayTransactionStatus): boolean {
  return TERMINAL_GATEWAY_STATUSES.includes(status);
}
