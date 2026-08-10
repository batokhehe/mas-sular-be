import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { GatewayTransactionStatus, OrderStatus, Payment, PaymentStatus, Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { buildOutboxEvent } from '../../../infrastructure/outbox/outbox-event.builder';
import { InventoryReservationService } from '../../inventory/inventory-reservation.service';
import { OrderCancellationService } from '../../orders/order-cancellation.service';
import { ShipmentService } from '../../shipment/shipment.service';

/**
 * Payment terminal states: once a payment reaches any of these it is final and no
 * further transition is allowed. PENDING and WAITING_VERIFICATION are the only
 * verifiable (non-terminal) states.
 *
 * MOVED HERE FROM AdminService (Phase 5D) so that admin verification and gateway
 * settlement share ONE state machine rather than growing a second one.
 */
export const TERMINAL_PAYMENT_STATUSES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.FAILED,
  PaymentStatus.EXPIRED,
  PaymentStatus.REFUNDED,
];

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status);
}

/**
 * Who is settling, and the only thing that differs between them: provenance.
 * The transition, the guards, the inventory commit, the event and the shipment are
 * identical — that is the whole point of this type existing.
 */
export type SettlementActor =
  | { kind: 'ADMIN'; adminId: string; note?: string | null; source?: string }
  /** A background owner (the payment lifecycle worker). Carries its own event source. */
  | { kind: 'SYSTEM'; source: string; note?: string | null }
  | {
      kind: 'GATEWAY';
      provider: string;
      /** Authoritative status word from the provider's Status API — never the webhook body. */
      providerStatus: string;
      providerTransactionId?: string | null;
      /** Ledger row to update in the SAME transaction (Phase 5D §5 atomicity). */
      gatewayTransactionId?: string | null;
      gatewayStatus?: GatewayTransactionStatus | null;
      note?: string | null;
      /** e.g. `payments.webhook.midtrans` or `payments.reconciliation.midtrans`. */
      source?: string;
    };

/**
 * The states a payment may be expired FROM. Mirrors PaymentLifecycleWorker's
 * ELIGIBLE_STATUSES exactly — expiry is narrower than "non-terminal" because a
 * payment awaiting verification of an uploaded receipt is still expirable, but
 * nothing else is.
 */
export const EXPIRY_ELIGIBLE_STATUSES: PaymentStatus[] = [
  PaymentStatus.PENDING,
  PaymentStatus.WAITING_VERIFICATION,
];

export type TerminalResult =
  /** This call performed the transition; the release and event ran exactly once. */
  | { result: 'APPLIED'; payment: Payment }
  /** Already in that terminal state — idempotent replay, no side effects. */
  | { result: 'ALREADY_TERMINAL'; payment: Payment };

export type SettlementResult =
  /** This call performed the transition; every side effect ran exactly once. */
  | { result: 'SETTLED'; payment: Payment }
  /** Already PAID — idempotent replay, no event, no audit, no inventory, no shipment. */
  | { result: 'ALREADY_PAID'; payment: Payment };

/**
 * THE settlement path. Both the admin verify flow and the Midtrans webhook route
 * through here, so there is exactly one place where a payment becomes PAID.
 *
 * ATOMICITY (§5): the payment flip, the order transition, the order event, the
 * inventory commit, the gateway ledger update, the audit record and the
 * `payment.paid` outbox event all run in ONE interactive transaction. Either every
 * business change commits or none does. The shipment is booked AFTER commit and
 * best-effort, preserving the existing architecture (§7).
 */
@Injectable()
export class PaymentSettlementService {
  private readonly logger = new Logger('PaymentSettlementService');

  constructor(
    private readonly prisma: PrismaService,
    // Optional so existing unit tests constructing collaborators positionally keep
    // working; when absent, automatic shipment creation is skipped (unchanged).
    @Optional() private readonly shipments?: ShipmentService,
    // Optional: commits reservations on settle (legacy flow when absent — stock was
    // decremented at checkout).
    @Optional() private readonly inventory?: InventoryReservationService,
    // Phase 5E: THE release path for the terminal transitions. Optional for the same
    // positional-construction reason; when absent, `fail`/`expire` still move the
    // payment but perform no restock (matching the legacy no-reservation flow).
    @Optional() private readonly cancellation?: OrderCancellationService,
  ) {}

  async settle(paymentId: string, actor: SettlementActor): Promise<SettlementResult> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.deletedAt) throw new NotFoundException('Payment not found');

    // Idempotent replay: already in the target terminal state (PAID) → return the
    // current payment with no side effects (no event, audit, order update, shipment).
    if (payment.status === PaymentStatus.PAID) {
      return { result: 'ALREADY_PAID', payment };
    }
    // Any OTHER terminal state (FAILED/EXPIRED/REFUNDED) cannot transition to PAID.
    // §19: this is what stops a late `settlement` resurrecting an EXPIRED payment.
    if (isTerminalPaymentStatus(payment.status)) {
      throw new ConflictException(`Payment cannot be verified from terminal status ${payment.status}`);
    }

    const verifiedAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // CAS over the non-terminal states. Under a concurrent double-settle only one
      // call flips the row (count === 1); the loser aborts before emitting a second
      // payment.paid — exactly-once event emission.
      const flip = await tx.payment.updateMany({
        where: { id: paymentId, status: { notIn: TERMINAL_PAYMENT_STATUSES } },
        data: {
          status: PaymentStatus.PAID,
          verifiedByUserId: actor.kind === 'ADMIN' ? actor.adminId : null,
          verifiedAt,
        },
      });
      if (flip.count !== 1) {
        throw new ConflictException('Payment already verified or rejected');
      }
      const updated = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });

      // Legal-transition guard (audit F4): a CANCELLED order must never be revived by
      // a settlement — its stock was already restocked. FOR UPDATE reads the CURRENT
      // status and blocks a concurrent cancel until this tx commits; on conflict
      // everything (incl. the payment flip above) rolls back.
      const rows = await tx.$queryRaw<Array<{ status: string }>>(
        Prisma.sql`SELECT status FROM \`Order\` WHERE id = ${payment.orderId} FOR UPDATE`,
      );
      const orderStatus = rows[0]?.status;
      if (!orderStatus || orderStatus === OrderStatus.CANCELLED) {
        throw new ConflictException('Order is cancelled; the payment can no longer be verified');
      }
      // Move PENDING → PROCESSING; an order already advanced past PROCESSING keeps
      // its (further) status — never a backwards transition.
      const orderFlip = await tx.order.updateMany({
        where: { id: payment.orderId, status: OrderStatus.PENDING },
        data: { status: OrderStatus.PROCESSING },
      });
      if (orderFlip.count === 1) {
        await tx.orderEvent.create({
          data: { orderId: payment.orderId, status: OrderStatus.PROCESSING, note: this.note(actor) },
        });
      }

      // Commit reservations: deduct Product.stock, mark COMMITTED — atomic with PAID.
      // The EXISTING reservation path; no second deduction logic, no direct
      // Product.stock write here.
      let committed = 0;
      if (this.inventory) {
        committed = await this.inventory.commitForOrder(tx, payment.orderId);
      }

      // Gateway ledger, in the SAME transaction (§5). CAS-guarded on a non-terminal
      // row so a replay cannot walk a settled attempt.
      if (actor.kind === 'GATEWAY' && actor.gatewayTransactionId) {
        await tx.paymentGatewayTransaction.updateMany({
          where: { id: actor.gatewayTransactionId },
          data: {
            ...(actor.gatewayStatus ? { status: actor.gatewayStatus } : {}),
            providerStatus: actor.providerStatus,
            providerStatusAt: verifiedAt,
            ...(actor.providerTransactionId ? { providerTransactionId: actor.providerTransactionId } : {}),
          },
        });
      }

      // actorId is NULL: AuditLog.actorId FKs to User, but the verifier is an Admin
      // (or the gateway). The identity is recorded in the JSON payload instead.
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'payment.verified',
          entity: 'Payment',
          entityId: updated.id,
          after: {
            ...(actor.kind === 'GATEWAY'
              ? {
                  settledBy: 'gateway',
                  provider: actor.provider,
                  providerStatus: actor.providerStatus,
                  providerTransactionId: actor.providerTransactionId ?? null,
                }
              : actor.kind === 'ADMIN'
                ? { verifiedByAdminId: actor.adminId }
                : { settledBy: 'system', source: this.source(actor) }),
            status: 'PAID',
            orderStatus: 'PROCESSING',
            note: actor.note ?? null,
            reservationsCommitted: committed,
          },
        },
      });

      // The ONE payment.paid construction. Same envelope builder (H2), same event
      // name, same routing key, same payload shape for both actors — only `source`
      // differs, so the existing consumer needs no change.
      await tx.outboxEvent.create({
        data: buildOutboxEvent({
          aggregateType: 'payment',
          aggregateId: updated.id,
          eventName: 'payment.paid',
          exchange: 'payments',
          routingKey: 'payment.paid',
          payload: {
            paymentId: updated.id,
            orderId: updated.orderId,
            amount: updated.amount,
            status: 'PAID',
            verifiedByUserId: updated.verifiedByUserId,
            verifiedAt: verifiedAt.toISOString(),
            orderStatus: 'PROCESSING',
          },
          metadata: { source: this.source(actor) },
          occurredAt: verifiedAt,
        }),
      });
      return updated;
    }, { timeout: 10000 });

    // Payment is now PAID (committed). Create the shipment automatically — OUTSIDE
    // the transaction and best-effort: if the courier API fails the payment stays
    // verified and the shipment is marked FAILED (admin can retry). This is the
    // EXISTING idempotent path, so one settled payment books at most once.
    if (this.shipments) {
      await this.shipments.createForOrderSafe(updated.orderId);
    }
    return { result: 'SETTLED', payment: updated };
  }

  /**
   * Terminal non-payment: deny, failure, cancel, capture+deny, admin reject.
   *
   * EXTRACTED FROM AdminService.rejectPayment (Phase 5E) so the gateway and the
   * admin share one FAILED transition. The body is that method's, unchanged: CAS
   * over the non-terminal states, the existing `cancelAndRestock` release path, and
   * one `payment.failed` event — all in a single transaction.
   */
  async fail(paymentId: string, actor: SettlementActor, reason: string): Promise<TerminalResult> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.deletedAt) throw new NotFoundException('Payment not found');

    // Idempotent replay: already FAILED → no restock, no event, no order change.
    if (payment.status === PaymentStatus.FAILED) {
      return { result: 'ALREADY_TERMINAL', payment };
    }
    // Any OTHER terminal state (PAID/EXPIRED/REFUNDED) cannot transition to FAILED.
    if (isTerminalPaymentStatus(payment.status)) {
      throw new ConflictException(`Payment cannot be rejected from terminal status ${payment.status}`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const flip = await tx.payment.updateMany({
        where: { id: paymentId, status: { notIn: TERMINAL_PAYMENT_STATUSES } },
        data: { status: PaymentStatus.FAILED },
      });
      if (flip.count !== 1) {
        throw new ConflictException('Payment already in a terminal state');
      }

      // THE release path — restock + reservation release, CAS-gated inside, so it
      // never double-restocks. No second inventory transition exists.
      await this.cancellation?.cancelAndRestock(tx, payment.orderId, reason);

      await this.recordGatewayState(tx, actor);

      await tx.outboxEvent.create({
        data: buildOutboxEvent({
          aggregateType: 'payment',
          aggregateId: payment.id,
          eventName: 'payment.failed',
          exchange: 'payments',
          routingKey: 'payment.failed',
          payload: { paymentId: payment.id, orderId: payment.orderId },
          metadata: { source: this.source(actor) },
        }),
      });

      return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    }, { timeout: 10000 });

    return { result: 'APPLIED', payment: updated };
  }

  /**
   * Charge window elapsed. EXTRACTED FROM PaymentLifecycleWorker.expirePayment
   * (Phase 5E), body unchanged — including the distinct `ReservationStatus.EXPIRED`
   * release reason, which is why expiry is NOT folded into `fail()`.
   */
  async expire(paymentId: string, actor: SettlementActor, reason: string): Promise<TerminalResult> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.deletedAt) throw new NotFoundException('Payment not found');

    if (payment.status === PaymentStatus.EXPIRED) {
      return { result: 'ALREADY_TERMINAL', payment };
    }
    if (isTerminalPaymentStatus(payment.status)) {
      throw new ConflictException(`Payment cannot be expired from terminal status ${payment.status}`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // CAS over the SAME eligible set the lifecycle worker uses.
      const flip = await tx.payment.updateMany({
        where: { id: paymentId, status: { in: EXPIRY_ELIGIBLE_STATUSES } },
        data: { status: PaymentStatus.EXPIRED },
      });
      if (flip.count !== 1) {
        throw new ConflictException('Payment already in a terminal state');
      }

      await this.cancellation?.cancelAndRestock(tx, payment.orderId, reason, ReservationStatus.EXPIRED);

      await this.recordGatewayState(tx, actor);

      await tx.outboxEvent.create({
        data: buildOutboxEvent({
          aggregateType: 'payment',
          aggregateId: payment.id,
          eventName: 'payment.expired',
          exchange: 'payments',
          routingKey: 'payment.expired',
          payload: { paymentId: payment.id, orderId: payment.orderId },
          metadata: { source: this.source(actor) },
        }),
      });

      return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    }, { timeout: 10000 });

    return { result: 'APPLIED', payment: updated };
  }

  /** Gateway ledger snapshot, inside whichever business transaction is running. */
  private async recordGatewayState(tx: Prisma.TransactionClient, actor: SettlementActor): Promise<void> {
    if (actor.kind !== 'GATEWAY' || !actor.gatewayTransactionId) return;
    await tx.paymentGatewayTransaction.updateMany({
      where: { id: actor.gatewayTransactionId },
      data: {
        ...(actor.gatewayStatus ? { status: actor.gatewayStatus } : {}),
        providerStatus: actor.providerStatus,
        providerStatusAt: new Date(),
        ...(actor.providerTransactionId ? { providerTransactionId: actor.providerTransactionId } : {}),
      },
    });
  }

  private note(actor: SettlementActor): string {
    if (actor.note) return actor.note;
    if (actor.kind === 'GATEWAY') return `Payment settled via ${actor.provider}`;
    if (actor.kind === 'SYSTEM') return 'Payment transitioned by the system';
    return 'Payment verified by admin';
  }

  /** Event provenance. Callers pass the exact source so existing values are preserved. */
  private source(actor: SettlementActor): string {
    if (actor.source) return actor.source;
    if (actor.kind === 'GATEWAY') return `payments.webhook.${actor.provider}`;
    if (actor.kind === 'SYSTEM') return 'system';
    return 'admin.verifyPayment';
  }
}
