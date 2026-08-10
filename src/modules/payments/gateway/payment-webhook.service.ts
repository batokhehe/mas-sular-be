import {
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PaymentGatewayTransaction, Prisma, WebhookSettlementState } from '@prisma/client';
import { LogService } from '../../../infrastructure/logging/log.service';
import { ApplyOutcome, GatewayStatusApplier } from './gateway-status-applier.service';
import { MidtransWebhookDto } from './application/dto/midtrans-webhook.dto';
import { verifyMidtransSignature } from './domain/midtrans-signature.util';
import { verifyMidtransStatusResponse } from './domain/midtrans-status-verification.util';
import { midtransWebhookFingerprint, parseMidtransNotificationTime } from './domain/midtrans-webhook-fingerprint.util';
import { MIDTRANS_CONFIG, MidtransConfig } from './midtrans.config';
import { PaymentGatewayPersistenceService, WebhookNotificationOutcome } from './payment-gateway-persistence.service';
import { PaymentProviderFactory } from './payment-provider.factory';

/** Provider key used for correlation. Matches `MidtransPaymentProvider.name`. */
export const MIDTRANS_PROVIDER = 'midtrans';

/** Wire contract — unchanged since Phase 5B and deliberately uninformative. */
export interface WebhookAck {
  received: true;
  handled: boolean;
}

/**
 * INTERNAL result. Never returned to the caller: telling a webhook sender whether a
 * transaction was found, deduplicated or superseded is exactly the enumeration
 * oracle we are avoiding. The controller collapses all of it to a flat ack.
 */
export type WebhookProcessingOutcome = WebhookNotificationOutcome | 'unknown_transaction';

/** What the business layer did — internal only, never surfaced to the caller. */
export type SettlementDecision = ApplyOutcome | 'already_processed' | 'unavailable' | 'skipped';

export interface WebhookProcessingResult {
  outcome: WebhookProcessingOutcome;
  settlement?: SettlementDecision;
}

/**
 * Settlement states after which a redelivery of the SAME notification is a true
 * no-op. `RECEIVED` and `VERIFICATION_FAILED` are deliberately absent: both mean the
 * business decision was never reached, so a retry must be allowed to reach it.
 */
const TERMINAL_SETTLEMENT_STATES: WebhookSettlementState[] = [
  WebhookSettlementState.SETTLED,
  WebhookSettlementState.NOT_ELIGIBLE,
];

/**
 * Fields copied into the stored notification snapshot.
 *
 * ALLOWLIST, not a denylist. Midtrans adds fields over time and the route pipe
 * deliberately does not strip unknown ones, so a denylist would silently start
 * persisting whatever future field arrives — including anything card-related.
 * `signature_key` is absent by construction, not by filtering.
 */
const SNAPSHOT_FIELDS = [
  'order_id',
  'transaction_id',
  'transaction_status',
  'status_code',
  'status_message',
  'fraud_status',
  'payment_type',
  'transaction_time',
  'settlement_time',
  'gross_amount',
  'currency',
  'merchant_id',
] as const satisfies readonly (keyof MidtransWebhookDto)[];

/** Build the redacted snapshot. Pure; exported so the tests can assert the allowlist. */
export function buildWebhookSnapshot(dto: MidtransWebhookDto): Prisma.InputJsonValue {
  const snapshot: Record<string, string> = {};
  for (const field of SNAPSHOT_FIELDS) {
    const value = dto[field];
    if (typeof value === 'string' && value.length > 0) snapshot[field] = value;
  }
  return snapshot;
}

/**
 * Midtrans notification boundary (Phase 5C).
 *
 * Authenticates, correlates, and durably records the notification — and stops there.
 * It reaches the database ONLY through `PaymentGatewayPersistenceService`, whose
 * public surface is the gateway ledger alone: there is no PrismaService here and no
 * payment, order, inventory, shipment, notification or outbox dependency, so moving
 * money remains structurally impossible until Phase 5D wires it deliberately.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger('PaymentWebhookService');

  constructor(
    @Inject(MIDTRANS_CONFIG) private readonly config: MidtransConfig,
    private readonly ledger: PaymentGatewayPersistenceService,
    @Optional() private readonly logs?: LogService,
    // Phase 5D/5E. Optional so a deployment (or a test) without the settlement
    // wiring still records notifications instead of failing them.
    @Optional() private readonly applier?: GatewayStatusApplier,
    @Optional() private readonly providers?: PaymentProviderFactory,
  ) {}

  /**
   * Order of operations is security-critical:
   *
   *   1. gateway availability → 503 (retryable, reveals nothing)
   *   2. signature            → 401
   *   3. correlate            ← FIRST database read, and it happens only after (2),
   *                             so an unsigned request cannot probe for an order
   *   4. record + snapshot    ← one transaction, deduplicated by a unique index
   */
  async handleMidtransNotification(dto: MidtransWebhookDto): Promise<WebhookProcessingResult> {
    // (1) Not configured here. 503 rather than 200 so a real notification is retried
    //     instead of being silently dropped.
    if (!this.config.enabled || !this.config.serverKey) {
      this.logger.warn('Midtrans notification received while the gateway is disabled');
      throw new ServiceUnavailableException('Payment gateway is not enabled');
    }

    // (2) The ONLY authentication. No JWT, no admin guard, no IP allowlist.
    const valid = verifyMidtransSignature(
      { orderId: dto.order_id, statusCode: dto.status_code, grossAmount: dto.gross_amount },
      this.config.serverKey,
      dto.signature_key,
    );

    if (!valid) {
      // Correlator only — never the received signature, the expected signature, the
      // server key, or the payload. Identical whether or not the order exists.
      this.logger.warn(`Midtrans notification rejected: invalid signature (order_id=${dto.order_id})`);
      this.logs?.write({
        level: 'WARN',
        module: 'payments.webhook',
        action: 'midtrans.signature_invalid',
        message: 'invalid Midtrans signature',
        metadata: { provider: MIDTRANS_PROVIDER, providerOrderId: dto.order_id, statusCode: dto.status_code },
      });
      throw new UnauthorizedException('Invalid signature');
    }

    // (3) Correlate on the exact id we sent the provider (Phase 5A). Never the bare
    //     application order number, and never rebuilt from parts.
    const transaction = await this.ledger.findByProviderOrderId(MIDTRANS_PROVIDER, dto.order_id);

    if (!transaction) {
      // Acknowledge: a 4xx/5xx here would make Midtrans retry a notification we can
      // never correlate, forever. Nothing is created — no ledger row, no payment, no
      // order, no dedup record, no event.
      this.logs?.write({
        level: 'WARN',
        module: 'payments.webhook',
        action: 'midtrans.unknown_transaction',
        message: 'no gateway transaction for this provider order id',
        metadata: { provider: MIDTRANS_PROVIDER, providerOrderId: dto.order_id, reason: 'unknown_transaction' },
      });
      // `skipped`, not a distinct shape: the result of an unknown order must look
      // exactly like any other so nothing downstream can branch on existence.
      return { outcome: 'unknown_transaction', settlement: 'skipped' };
    }

    const fingerprint = midtransWebhookFingerprint({
      orderId: dto.order_id,
      transactionId: dto.transaction_id ?? null,
      statusCode: dto.status_code,
      transactionStatus: dto.transaction_status ?? null,
      fraudStatus: dto.fraud_status ?? null,
      grossAmount: dto.gross_amount, // verbatim — the string that was signed
    });

    // (4) Atomic: dedup row + gateway snapshot, or neither.
    const outcome = await this.ledger.recordWebhookNotification({
      provider: MIDTRANS_PROVIDER,
      fingerprint,
      gatewayTransactionId: transaction.id,
      providerOrderId: dto.order_id,
      providerTransactionId: dto.transaction_id ?? null,
      // Fill in only when the ledger has no id yet; never overwrite the charge value.
      fillProviderTransactionId: transaction.providerTransactionId ? null : dto.transaction_id ?? null,
      providerStatus: dto.transaction_status ?? null, // exactly as received, unmapped
      transactionStatus: dto.transaction_status ?? null,
      statusCode: dto.status_code,
      fraudStatus: dto.fraud_status ?? null,
      grossAmount: dto.gross_amount,
      notifiedAt: parseMidtransNotificationTime(dto),
      payload: buildWebhookSnapshot(dto),
    });

    this.logs?.write({
      level: 'INFO',
      module: 'payments.webhook',
      action: `midtrans.${outcome}`,
      message: `notification ${outcome} for ${dto.order_id}`,
      paymentId: transaction.paymentId,
      metadata: {
        provider: MIDTRANS_PROVIDER,
        providerOrderId: dto.order_id,
        transactionId: dto.transaction_id ?? null,
        transactionStatus: dto.transaction_status ?? null,
        statusCode: dto.status_code,
        deduplicated: outcome === 'duplicate',
        reason: outcome,
      },
    });

    // (5) Business settlement (Phase 5D) — driven by the Status API, never by the
    //     notification body.
    const settlement = await this.settleFromAuthoritativeStatus(fingerprint, transaction, dto);
    return { outcome, settlement };
  }

  /**
   * Decide and apply the business transition using the AUTHORITATIVE provider status.
   *
   * The webhook body is treated purely as a trigger. Its signature covers only
   * order_id, status_code and gross_amount — `transaction_status`, `fraud_status`
   * and `transaction_id` are UNAUTHENTICATED, so none of them may move money.
   */
  private async settleFromAuthoritativeStatus(
    fingerprint: string,
    transaction: PaymentGatewayTransaction,
    dto: MidtransWebhookDto,
  ): Promise<SettlementDecision> {
    // A redelivery whose business decision is already terminal is a true no-op.
    // RECEIVED / VERIFICATION_FAILED deliberately fall through and try again, so a
    // Status API outage can never permanently swallow a real payment.
    const recorded = await this.ledger.findWebhookEvent(fingerprint);
    if (recorded && TERMINAL_SETTLEMENT_STATES.includes(recorded.settlementState)) {
      return 'already_processed';
    }

    if (!this.applier || !this.providers) {
      // Settlement collaborators absent (legacy positional construction) — record
      // the notification, change nothing.
      return 'unavailable';
    }

    // (a) Authoritative read over the existing, server-key-authenticated HTTP client.
    //     No second client, and the key never leaves the provider layer.
    let raw: unknown;
    try {
      const provider = this.providers.get(MIDTRANS_PROVIDER);
      // Absent only if the gateway was disabled between the check above and here;
      // treated as "truth unavailable", never as "not paid".
      if (!provider) throw new Error('midtrans provider is not registered');
      const status = await provider.getStatus({
        paymentId: transaction.paymentId,
        // Phase 5A's exact id — Midtrans keys /v2/{id}/status on the order_id we sent.
        providerReference: transaction.providerOrderId,
      });
      raw = status.raw;
    } catch (err) {
      // Timeout, 429, 5xx, permanent rejection — we could not establish truth.
      // NOTHING is mutated and the notification stays re-processable.
      await this.ledger.markWebhookSettlementState(fingerprint, WebhookSettlementState.VERIFICATION_FAILED);
      this.logs?.write({
        level: 'ERROR',
        module: 'payments.webhook',
        action: 'midtrans.status_unavailable',
        message: 'authoritative status could not be established',
        paymentId: transaction.paymentId,
        metadata: {
          provider: MIDTRANS_PROVIDER,
          providerOrderId: transaction.providerOrderId,
          reason: 'status_api_unavailable',
          // Class of failure only — never the response body or the request headers.
          error: err instanceof Error ? err.name : 'unknown',
        },
      });
      // 503 tells Midtrans to redeliver. Nothing has changed, so a retry is safe.
      throw new ServiceUnavailableException('Payment status could not be verified');
    }

    // (b) Certify the response before believing a word of it (§17).
    const verified = verifyMidtransStatusResponse(raw, transaction.providerOrderId ?? '', transaction.grossAmount);
    if (!verified.ok) {
      await this.ledger.markWebhookSettlementState(fingerprint, WebhookSettlementState.NOT_ELIGIBLE);
      this.logs?.write({
        level: 'ERROR',
        module: 'payments.webhook',
        action: 'midtrans.status_anomaly',
        message: 'authoritative status failed verification',
        paymentId: transaction.paymentId,
        metadata: {
          provider: MIDTRANS_PROVIDER,
          providerOrderId: transaction.providerOrderId,
          reason: verified.reason, // safe: a classification, not the response
        },
      });
      return 'not_eligible';
    }

    // (c) THE shared business path (Phase 5E §5) — the same applier the
    //     reconciliation worker uses. No webhook-specific state machine exists.
    try {
      const outcome = await this.applier.apply({
        transaction,
        verified,
        source: `payments.webhook.${MIDTRANS_PROVIDER}`,
      });
      await this.ledger.markWebhookSettlementState(fingerprint, SETTLEMENT_STATE_BY_OUTCOME[outcome]);
      return outcome;
    } catch (err) {
      // Rolled back — nothing partial committed, so the notification must stay
      // re-processable and Midtrans should redeliver.
      await this.ledger.markWebhookSettlementState(fingerprint, WebhookSettlementState.VERIFICATION_FAILED);
      this.logs?.write({
        level: 'WARN',
        module: 'payments.webhook',
        action: 'midtrans.transition_failed',
        message: 'business transition did not apply',
        paymentId: transaction.paymentId,
        metadata: {
          provider: MIDTRANS_PROVIDER,
          providerOrderId: transaction.providerOrderId,
          reason: 'transition_failed',
        },
      });
      throw err;
    }
  }
}

/**
 * How a business outcome closes out the notification (§13).
 *
 * Every outcome here is a REACHED CONCLUSION, so all of them are terminal for the
 * notification. `VERIFICATION_FAILED` is reserved for the cases where no conclusion
 * was reached — an unreachable Status API or a rolled-back transaction — because
 * only those must be retried.
 */
const SETTLEMENT_STATE_BY_OUTCOME: Record<ApplyOutcome, WebhookSettlementState> = {
  settled: WebhookSettlementState.SETTLED,
  failed: WebhookSettlementState.SETTLED,
  expired: WebhookSettlementState.SETTLED,
  already_terminal: WebhookSettlementState.SETTLED,
  not_eligible: WebhookSettlementState.NOT_ELIGIBLE,
  illegal_transition: WebhookSettlementState.NOT_ELIGIBLE,
};
