import { Injectable, Logger } from '@nestjs/common';
import {
  GatewayTransactionStatus,
  PaymentGatewayTransaction,
  PaymentWebhookEvent,
  Prisma,
  WebhookSettlementState,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { isTerminalGatewayStatus } from './domain/gateway-status.mapper';

/** Gateway states that mean "this attempt is still live" — at most one per payment. */
const ACTIVE: GatewayTransactionStatus[] = [GatewayTransactionStatus.PENDING, GatewayTransactionStatus.AUTHORIZED];

export interface CreatePendingTransactionInput {
  paymentId: string;
  provider: string;
  channelCode: string;
  grossAmount: number;
  currency?: string;
  providerOrderId?: string | null;
  rawRequest?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
}

/** Provider response fields recorded after a charge call returns. */
export interface GatewayResponseInput {
  status?: GatewayTransactionStatus;
  /** Corrects the placeholder written at creation with the id actually charged. */
  providerOrderId?: string | null;
  providerReference?: string | null;
  providerTransactionId?: string | null;
  redirectUrl?: string | null;
  deeplinkUrl?: string | null;
  qrString?: string | null;
  vaNumber?: string | null;
  expiryAt?: Date | null;
  rawResponse?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
  failureReason?: string | null;
}

/** Verified notification to be recorded (Phase 5C). Amounts stay strings — verbatim. */
export interface WebhookNotificationInput {
  provider: string;
  /** SHA-256 canonical identity; the unique index on it is the dedup invariant. */
  fingerprint: string;
  gatewayTransactionId: string;
  providerOrderId: string;
  providerTransactionId?: string | null;
  /** Only set when the ledger row has no id yet — never an overwrite. */
  fillProviderTransactionId?: string | null;
  /** Provider's status word, stored exactly as received. */
  providerStatus?: string | null;
  transactionStatus?: string | null;
  statusCode?: string | null;
  fraudStatus?: string | null;
  grossAmount: string;
  notifiedAt?: Date | null;
  /** ALLOWLISTED snapshot — the caller must exclude signature_key and credentials. */
  payload: Prisma.InputJsonValue;
}

/**
 * `applied`   — recorded and the ledger snapshot was refreshed.
 * `duplicate` — this exact notification was already processed; nothing changed.
 * `stale`     — recorded, but an unambiguously newer notification already won.
 */
export type WebhookNotificationOutcome = 'applied' | 'duplicate' | 'stale';

/**
 * A unique violation on the webhook fingerprint — i.e. a duplicate delivery.
 *
 * Deliberately NOT a bare `code === 'P2002'`: the ledger also carries
 * `@@unique([provider, providerTransactionId])`, and swallowing THAT as a duplicate
 * would hide two attempts claiming one provider transaction — a real data anomaly
 * that must surface loudly rather than be acknowledged as a no-op.
 */
function isFingerprintConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((f) => f.includes('fingerprint'));
}

/**
 * PERSISTENCE ONLY for the gateway ledger — no HTTP, no SDK, no provider logic,
 * no business-status writes. It never touches the `Payment` row: moving a payment
 * to PAID/FAILED stays the exclusive job of the existing CAS-guarded flows
 * (admin verify/reject, expiry worker), which Phase 4 will drive.
 */
@Injectable()
export class PaymentGatewayPersistenceService {
  private readonly logger = new Logger('PaymentGatewayPersistence');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Open a PENDING ledger row for a charge attempt.
   *
   * Duplicate protection: a payment may hold only ONE live attempt. If an active
   * row already exists for the same payment + provider + channel it is returned
   * unchanged (idempotent re-initiation); an active row on a DIFFERENT channel is
   * cancelled first, so switching QRIS → GoPay leaves exactly one live attempt.
   */
  async createPendingTransaction(input: CreatePendingTransactionInput): Promise<PaymentGatewayTransaction> {
    const existing = await this.prisma.paymentGatewayTransaction.findFirst({
      where: { paymentId: input.paymentId, status: { in: ACTIVE } },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      if (existing.provider === input.provider && existing.channelCode === input.channelCode) {
        return existing; // same attempt replayed — hand back the live row
      }
      await this.prisma.paymentGatewayTransaction.updateMany({
        where: { id: existing.id, status: { in: ACTIVE } }, // CAS: never revive a settled row
        data: { status: GatewayTransactionStatus.CANCELLED, failureReason: 'Superseded by a new channel selection' },
      });
    }

    return this.prisma.paymentGatewayTransaction.create({
      data: {
        paymentId: input.paymentId,
        provider: input.provider,
        channelCode: input.channelCode,
        grossAmount: input.grossAmount,
        currency: input.currency ?? 'IDR',
        providerOrderId: input.providerOrderId ?? null,
        status: GatewayTransactionStatus.PENDING,
        rawRequest: input.rawRequest,
        metadata: input.metadata,
      },
    });
  }

  /** Record what the provider returned. Only the supplied fields are written. */
  async updateGatewayResponse(id: string, response: GatewayResponseInput): Promise<PaymentGatewayTransaction> {
    return this.prisma.paymentGatewayTransaction.update({
      where: { id },
      data: {
        ...(response.status !== undefined ? { status: response.status } : {}),
        ...(response.providerOrderId !== undefined ? { providerOrderId: response.providerOrderId } : {}),
        ...(response.providerReference !== undefined ? { providerReference: response.providerReference } : {}),
        ...(response.providerTransactionId !== undefined ? { providerTransactionId: response.providerTransactionId } : {}),
        ...(response.redirectUrl !== undefined ? { redirectUrl: response.redirectUrl } : {}),
        ...(response.deeplinkUrl !== undefined ? { deeplinkUrl: response.deeplinkUrl } : {}),
        ...(response.qrString !== undefined ? { qrString: response.qrString } : {}),
        ...(response.vaNumber !== undefined ? { vaNumber: response.vaNumber } : {}),
        ...(response.expiryAt !== undefined ? { expiryAt: response.expiryAt } : {}),
        ...(response.rawResponse !== undefined ? { rawResponse: response.rawResponse } : {}),
        ...(response.metadata !== undefined ? { metadata: response.metadata } : {}),
        ...(response.failureReason !== undefined ? { failureReason: response.failureReason } : {}),
      },
    });
  }

  /** Settled successfully. */
  markSuccess(id: string, patch: GatewayResponseInput = {}): Promise<{ changed: boolean }> {
    return this.transition(id, patch.status ?? GatewayTransactionStatus.SETTLEMENT, patch);
  }

  /** Charge window elapsed with no payment. */
  markExpired(id: string, patch: GatewayResponseInput = {}): Promise<{ changed: boolean }> {
    return this.transition(id, GatewayTransactionStatus.EXPIRED, patch);
  }

  /** Provider rejected / errored. */
  markFailed(id: string, failureReason: string, patch: GatewayResponseInput = {}): Promise<{ changed: boolean }> {
    return this.transition(id, GatewayTransactionStatus.FAILED, { ...patch, failureReason: failureReason.slice(0, 512) });
  }

  /**
   * CAS transition guarded on the CURRENT row being non-terminal, so an out-of-order
   * or replayed provider callback can never walk a settled attempt backwards.
   * Returns whether this call performed the change (idempotent for the caller).
   */
  private async transition(
    id: string,
    status: GatewayTransactionStatus,
    patch: GatewayResponseInput,
  ): Promise<{ changed: boolean }> {
    const { count } = await this.prisma.paymentGatewayTransaction.updateMany({
      where: { id, status: { notIn: [...TERMINAL] } },
      data: {
        status,
        ...(patch.providerReference !== undefined ? { providerReference: patch.providerReference } : {}),
        ...(patch.providerTransactionId !== undefined ? { providerTransactionId: patch.providerTransactionId } : {}),
        ...(patch.rawResponse !== undefined ? { rawResponse: patch.rawResponse } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
        ...(patch.expiryAt !== undefined ? { expiryAt: patch.expiryAt } : {}),
      },
    });
    if (count !== 1) {
      this.logger.warn(`gateway transaction ${id} already terminal or missing — ${status} transition skipped`);
    }
    return { changed: count === 1 };
  }

  /** Most recent attempt for a payment (what the customer is currently looking at). */
  findLatestByPayment(paymentId: string): Promise<PaymentGatewayTransaction | null> {
    return this.prisma.paymentGatewayTransaction.findFirst({
      where: { paymentId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Correlate an inbound gateway notification to its attempt (Phase 5A).
   * `providerOrderId` is the id WE sent and the gateway signs and echoes back, so
   * it is the only safe correlation key. Provider-scoped and index-backed
   * (`@@index([provider, providerOrderId])`); newest-first because the column is
   * intentionally non-unique.
   */
  findByProviderOrderId(provider: string, providerOrderId: string): Promise<PaymentGatewayTransaction | null> {
    return this.prisma.paymentGatewayTransaction.findFirst({
      where: { provider, providerOrderId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Atomically record a verified provider notification and refresh the attempt's
   * gateway-level snapshot (Phase 5C).
   *
   * IDEMPOTENCY IS THE DATABASE'S JOB. The `PaymentWebhookEvent.fingerprint` unique
   * index is the whole mechanism: there is no read-then-write check, so two
   * deliveries racing on separate connections cannot both pass. The loser's INSERT
   * fails with P2002 and its transaction — including the ledger update — rolls back.
   *
   * ORDER MATTERS. The dedup row is inserted BEFORE the ledger update and inside the
   * SAME transaction, so the notification is only "processed" at commit: if the
   * ledger update throws, the fingerprint is released and the notification can be
   * delivered again. A failed attempt never permanently consumes the key.
   *
   * Returns which of the three things happened; it does NOT touch Payment or Order.
   */
  async recordWebhookNotification(input: WebhookNotificationInput): Promise<WebhookNotificationOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // (1) Dedup gate. First statement in the transaction, and the only one that
        //     can decide "duplicate".
        await tx.paymentWebhookEvent.create({
          data: {
            provider: input.provider,
            fingerprint: input.fingerprint,
            providerOrderId: input.providerOrderId,
            providerTransactionId: input.providerTransactionId ?? null,
            transactionStatus: input.transactionStatus ?? null,
            statusCode: input.statusCode ?? null,
            fraudStatus: input.fraudStatus ?? null,
            grossAmount: input.grossAmount,
            gatewayTransactionId: input.gatewayTransactionId,
            payload: input.payload,
            notifiedAt: input.notifiedAt ?? null,
          },
        });

        // (2) Gateway-level snapshot ONLY. No status enum move, no Payment write —
        //     mapping provider vocabulary onto PaymentStatus is Phase 5D's job, and
        //     doing it here would leave a settled gateway row against a PENDING
        //     payment with no reconciliation process to close the gap.
        const { count } = await tx.paymentGatewayTransaction.updateMany({
          where: {
            AND: [
              { id: input.gatewayTransactionId },
              // Monotonic guard: refuse a strictly older notification. Skipped when
              // the incoming time is unknown — see parseMidtransNotificationTime.
              input.notifiedAt
                ? { OR: [{ providerStatusAt: null }, { providerStatusAt: { lte: input.notifiedAt } }] }
                : {},
            ],
          },
          data: {
            ...(input.providerStatus !== undefined ? { providerStatus: input.providerStatus } : {}),
            ...(input.notifiedAt ? { providerStatusAt: input.notifiedAt } : {}),
            // Only ever FILLS IN a missing id. Never overwrites the value recorded at
            // charge time, so the `@@unique([provider, providerTransactionId])`
            // idempotency anchor cannot be walked onto another attempt's id.
            ...(input.fillProviderTransactionId ? { providerTransactionId: input.fillProviderTransactionId } : {}),
          },
        });

        // count===0 means the row lost the ordering guard (or vanished). The event is
        // still committed — nothing is lost, the denormalized snapshot just keeps the
        // newer value.
        return count === 1 ? 'applied' : 'stale';
      });
    } catch (err) {
      if (isFingerprintConflict(err)) return 'duplicate';
      throw err; // any other failure → rolled back → redeliverable
    }
  }

  /** The recorded notification, by its deterministic identity. */
  findWebhookEvent(fingerprint: string): Promise<PaymentWebhookEvent | null> {
    return this.prisma.paymentWebhookEvent.findUnique({ where: { fingerprint } });
  }

  /**
   * Record how far BUSINESS processing got (Phase 5D).
   *
   * Separate from receipt on purpose: `RECEIVED` and `VERIFICATION_FAILED` both mean
   * "try again on redelivery", so a Status API outage never converts a real payment
   * into a permanently swallowed notification. Only `SETTLED` and `NOT_ELIGIBLE` are
   * terminal for a given notification.
   */
  async markWebhookSettlementState(fingerprint: string, state: WebhookSettlementState): Promise<void> {
    await this.prisma.paymentWebhookEvent.updateMany({ where: { fingerprint }, data: { settlementState: state } });
  }

  /** Webhook lookup path (Phase 4). Provider-scoped: references are only unique per provider. */
  findByProviderReference(provider: string, providerReference: string): Promise<PaymentGatewayTransaction | null> {
    return this.prisma.paymentGatewayTransaction.findFirst({
      where: { provider, providerReference },
      orderBy: { createdAt: 'desc' },
    });
  }
}

/** Terminal set, derived from the shared mapper so the two never drift. */
const TERMINAL = (Object.values(GatewayTransactionStatus) as GatewayTransactionStatus[]).filter(isTerminalGatewayStatus);
