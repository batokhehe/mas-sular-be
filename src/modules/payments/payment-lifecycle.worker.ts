import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Payment, PaymentMethod, PaymentStatus, ReservationStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { OrderCancellationService } from '../orders/order-cancellation.service';
import { PAYMENT_LIFECYCLE_CONFIG, PaymentLifecycleConfig } from './payment-lifecycle.config';
import { PaymentLifecycleMetrics } from './payment-lifecycle.metrics';
import { PaymentUploadTokenService } from './payment-upload-token.service';

// A payment is reminder/expiry-eligible only while still awaiting payment/verification.
const ELIGIBLE_STATUSES: PaymentStatus[] = [PaymentStatus.PENDING, PaymentStatus.WAITING_VERIFICATION];
// Reminders carry an upload link, so they only apply to receipt-upload methods.
const REMINDER_METHODS: PaymentMethod[] = [PaymentMethod.BANK_TRANSFER, PaymentMethod.QRIS];

/**
 * Self-scheduled worker that (1) sends 1st/2nd payment reminders and (2) expires
 * abandoned non-COD payments, cancelling the order and restoring stock. Both
 * passes are idempotent and concurrency-safe via per-row CAS transitions (the
 * reminder timestamp / the EXPIRED terminal transition), so duplicate runs and
 * concurrent workers never double-send or double-expire. Disabled by default.
 */
@Injectable()
export class PaymentLifecycleWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('PaymentLifecycleWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  // Overridable seam for deterministic tests.
  private nowMs: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadTokens: PaymentUploadTokenService,
    private readonly cancellation: OrderCancellationService,
    private readonly metrics: PaymentLifecycleMetrics,
    @Inject(PAYMENT_LIFECYCLE_CONFIG) private readonly config: PaymentLifecycleConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('Payment lifecycle disabled (PAYMENT_LIFECYCLE_ENABLED=false)');
      return;
    }
    this.logger.log(`Payment lifecycle starting (interval=${this.config.pollIntervalMs}ms, batch=${this.config.batchSize})`);
    this.scheduleNext(this.config.initialDelayMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // already logged
      }
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.runTick(), delayMs);
    this.timer.unref();
  }

  private async runTick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    this.inFlight = (async () => {
      try {
        // Expire first so an about-to-expire payment is not also reminded.
        await this.runExpiry();
        await this.runReminders();
      } catch (err) {
        this.logger.error(`payment lifecycle tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    await this.inFlight;
    this.inFlight = null;
    this.running = false;
    this.scheduleNext(this.config.pollIntervalMs);
  }

  // ---------------- Expiry ----------------

  /** Per-method expiry window in ms, or null when the method never expires. */
  private expiryWindowMs(method: PaymentMethod): number | null {
    if (method === PaymentMethod.BANK_TRANSFER || method === PaymentMethod.QRIS) return this.config.expiryAfterMs;
    if (method === PaymentMethod.GATEWAY) return this.config.gatewayExpiryAfterMs > 0 ? this.config.gatewayExpiryAfterMs : null;
    return null; // COD never expires
  }

  async runExpiry(): Promise<number> {
    const methods: PaymentMethod[] = [PaymentMethod.BANK_TRANSFER, PaymentMethod.QRIS];
    if (this.config.gatewayExpiryAfterMs > 0) methods.push(PaymentMethod.GATEWAY);
    const minWindow = Math.min(
      this.config.expiryAfterMs,
      this.config.gatewayExpiryAfterMs > 0 ? this.config.gatewayExpiryAfterMs : Number.POSITIVE_INFINITY,
    );

    const candidates = await this.prisma.payment.findMany({
      where: {
        status: { in: ELIGIBLE_STATUSES },
        method: { in: methods },
        deletedAt: null,
        createdAt: { lte: new Date(this.nowMs() - minWindow) }, // coarse filter; exact per-method below
      },
      orderBy: { createdAt: 'asc' },
      take: this.config.batchSize,
    });

    let expired = 0;
    for (const payment of candidates) {
      const window = this.expiryWindowMs(payment.method);
      if (window === null || this.nowMs() - payment.createdAt.getTime() < window) continue; // not yet due for this method
      if (await this.expirePayment(payment)) expired += 1;
    }
    return expired;
  }

  async expirePayment(payment: Payment): Promise<boolean> {
    try {
      const didExpire = await this.prisma.$transaction(async (tx) => {
        // CAS: only a non-terminal payment transitions to EXPIRED. Idempotent +
        // concurrency-safe: the loser of a race gets count 0 and does nothing.
        const flip = await tx.payment.updateMany({
          where: { id: payment.id, status: { in: ELIGIBLE_STATUSES } },
          data: { status: PaymentStatus.EXPIRED },
        });
        if (flip.count !== 1) return false;

        await this.cancellation.cancelAndRestock(
          tx,
          payment.orderId,
          'Payment expired (no receipt within the payment window)',
          ReservationStatus.EXPIRED,
        );

        await tx.outboxEvent.create({
          data: {
            id: randomUUID(),
            aggregateType: 'payment',
            aggregateId: payment.id,
            eventName: 'payment.expired',
            eventVersion: 1,
            exchange: 'payments',
            routingKey: 'payment.expired',
            payload: { paymentId: payment.id, orderId: payment.orderId },
            metadata: { source: 'payment.lifecycle.expiry' },
            occurredAt: new Date(this.nowMs()),
          },
        });
        return true;
      }, { timeout: 10000 });

      if (didExpire) this.metrics.paymentExpired();
      return didExpire;
    } catch (err) {
      // Transient failure → left as-is, retried on the next tick.
      this.logger.error(`expire payment ${payment.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ---------------- Reminders ----------------

  async runReminders(): Promise<number> {
    const now = this.nowMs();
    let sent = 0;

    const firstDue = await this.prisma.payment.findMany({
      where: {
        status: { in: ELIGIBLE_STATUSES },
        method: { in: REMINDER_METHODS },
        deletedAt: null,
        firstReminderAt: null,
        createdAt: { lte: new Date(now - this.config.firstReminderAfterMs) },
      },
      orderBy: { createdAt: 'asc' },
      take: this.config.batchSize,
    });
    for (const payment of firstDue) {
      if (await this.sendReminder(payment, 'first')) sent += 1;
    }

    const secondDue = await this.prisma.payment.findMany({
      where: {
        status: { in: ELIGIBLE_STATUSES },
        method: { in: REMINDER_METHODS },
        deletedAt: null,
        firstReminderAt: { not: null },
        secondReminderAt: null,
        createdAt: { lte: new Date(now - this.config.secondReminderAfterMs) },
      },
      orderBy: { createdAt: 'asc' },
      take: this.config.batchSize,
    });
    for (const payment of secondDue) {
      if (await this.sendReminder(payment, 'second')) sent += 1;
    }
    return sent;
  }

  async sendReminder(payment: Payment, stage: 'first' | 'second'): Promise<boolean> {
    try {
      const claimed = await this.prisma.$transaction(async (tx) => {
        // CAS-claim the reminder slot. Exactly one caller flips the timestamp,
        // status-guarded so a paid/failed/expired payment is never reminded.
        // One send per stage; the token + event are emitted in the SAME tx, so a
        // payment.reminder event is produced at most once per stage.
        const cas = stage === 'first'
          ? await tx.payment.updateMany({
              where: { id: payment.id, status: { in: ELIGIBLE_STATUSES }, firstReminderAt: null },
              data: { firstReminderAt: new Date(this.nowMs()) },
            })
          : await tx.payment.updateMany({
              where: { id: payment.id, status: { in: ELIGIBLE_STATUSES }, secondReminderAt: null },
              data: { secondReminderAt: new Date(this.nowMs()) },
            });
        if (cas.count !== 1) return false;

        // Only the SHA-256 hash of a token is stored, so a prior token's raw secret
        // cannot be recovered — always mint a fresh single-use token for the link.
        const issued = await this.uploadTokens.issue(tx, payment.id);

        await tx.outboxEvent.create({
          data: {
            id: randomUUID(),
            aggregateType: 'payment',
            aggregateId: payment.id,
            eventName: 'payment.reminder',
            eventVersion: 1,
            exchange: 'payments',
            routingKey: 'payment.reminder',
            payload: {
              paymentId: payment.id,
              orderId: payment.orderId,
              stage,
              paymentMethod: payment.method,
              amount: payment.amount,
              uploadUrl: issued.uploadUrl,
            },
            metadata: { source: 'payment.lifecycle.reminder' },
            occurredAt: new Date(this.nowMs()),
          },
        });
        return true;
      }, { timeout: 10000 });

      if (claimed) this.metrics.reminder(stage);
      return claimed;
    } catch (err) {
      this.logger.error(`send ${stage} reminder for payment ${payment.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
