import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { PaymentGatewayTransaction, PaymentStatus } from '@prisma/client';
import { LogService } from '../../../infrastructure/logging/log.service';
import { PaymentSettlementService, SettlementActor } from '../settlement/payment-settlement.service';
import { StatusVerification } from './domain/midtrans-status-verification.util';

/**
 * THE convergence point (Phase 5E §5).
 *
 * The webhook and the reconciliation worker both arrive here with an already
 * VERIFIED provider status, and this is the only place that decides what it means
 * for the business. There is no webhook state machine and no reconciliation state
 * machine — both call `apply()`, which dispatches to the one shared transition in
 * PaymentSettlementService.
 *
 * The dispatch is driven entirely by the EXISTING mapper chain
 * (`mapMidtransStatus` → `mapGatewayStatusToPaymentStatus`), so no terminal-state
 * policy is invented here: `cancel` reaching FAILED, `capture`+challenge staying
 * PENDING and `expire` reaching EXPIRED are all decisions those mappers already own.
 */
export type ApplyOutcome =
  /** Payment moved to its new terminal state by this call. */
  | 'settled'
  | 'failed'
  | 'expired'
  /** Already in that state — idempotent replay, no side effects ran. */
  | 'already_terminal'
  /** Authoritative status does not warrant any transition (pending, refund, …). */
  | 'not_eligible'
  /** A legal-transition refusal: terminal payment or cancelled order. */
  | 'illegal_transition';

export interface ApplyRequest {
  transaction: PaymentGatewayTransaction;
  verified: Extract<StatusVerification, { ok: true }>;
  /** `payments.webhook.midtrans` or `payments.reconciliation.midtrans`. */
  source: string;
}

@Injectable()
export class GatewayStatusApplier {
  private readonly logger = new Logger('GatewayStatusApplier');

  constructor(
    private readonly settlement: PaymentSettlementService,
    @Optional() private readonly logs?: LogService,
  ) {}

  async apply({ transaction, verified, source }: ApplyRequest): Promise<ApplyOutcome> {
    const actor: SettlementActor = {
      kind: 'GATEWAY',
      provider: transaction.provider,
      providerStatus: verified.facts.transactionStatus,
      providerTransactionId: verified.facts.transactionId,
      gatewayTransactionId: transaction.id,
      gatewayStatus: verified.gatewayStatus,
      source,
    };
    const reason = `Midtrans reported ${verified.facts.transactionStatus}`;

    try {
      switch (verified.paymentStatus) {
        // settlement, and capture with an acceptable fraud state.
        case PaymentStatus.PAID: {
          const out = await this.settlement.settle(transaction.paymentId, actor);
          return this.record(transaction, verified, source, out.result === 'SETTLED' ? 'settled' : 'already_terminal');
        }

        // deny, failure, cancel, capture+deny → the existing FAILED path, with its
        // restock and its `payment.failed` event.
        case PaymentStatus.FAILED: {
          const out = await this.settlement.fail(transaction.paymentId, actor, reason);
          return this.record(transaction, verified, source, out.result === 'APPLIED' ? 'failed' : 'already_terminal');
        }

        // expire → the existing expiry path, which releases reservations as EXPIRED
        // rather than as a plain cancellation.
        case PaymentStatus.EXPIRED: {
          const out = await this.settlement.expire(transaction.paymentId, actor, reason);
          return this.record(transaction, verified, source, out.result === 'APPLIED' ? 'expired' : 'already_terminal');
        }

        // pending / authorized (capture+challenge) — money has not moved and may
        // still. REFUNDED is deliberately inert: refunds are out of scope, and
        // guessing a reversal policy here would be worse than leaving it visible.
        default:
          return this.record(transaction, verified, source, 'not_eligible');
      }
    } catch (err) {
      if (err instanceof ConflictException) {
        // Terminal payment or cancelled order: a conclusion, not a failure. Retrying
        // can never change it, so callers must not treat this as retryable.
        return this.record(transaction, verified, source, 'illegal_transition', err.message);
      }
      throw err; // rolled back → nothing partial → caller may retry
    }
  }

  /** Safe observability. Correlators only — never a raw response or a credential. */
  private record(
    transaction: PaymentGatewayTransaction,
    verified: Extract<StatusVerification, { ok: true }>,
    source: string,
    result: ApplyOutcome,
    reason?: string,
  ): ApplyOutcome {
    this.logs?.write({
      level: result === 'illegal_transition' ? 'WARN' : 'INFO',
      module: 'payments.gateway',
      action: `gateway.apply.${result}`,
      message: `${verified.facts.transactionStatus} → ${result}`,
      paymentId: transaction.paymentId,
      metadata: {
        provider: transaction.provider,
        providerOrderId: transaction.providerOrderId,
        providerTransactionId: verified.facts.transactionId,
        providerStatus: verified.facts.transactionStatus,
        result,
        reason: reason ?? result,
        source,
      },
    });
    return result;
  }
}
