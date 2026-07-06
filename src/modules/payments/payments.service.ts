import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Payment, PaymentStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { UploadManualPaymentDto } from './application/dto/payment.dto';
import { PaymentUploadTokenService } from './payment-upload-token.service';

// A receipt may only be uploaded while the payment is still awaiting payment/verification.
const UPLOADABLE_STATUSES: PaymentStatus[] = [PaymentStatus.PENDING, PaymentStatus.WAITING_VERIFICATION];

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadTokens: PaymentUploadTokenService,
  ) {}

  /**
   * Authenticated receipt upload. Ownership-scoped (the payment must belong to the
   * caller — closes the IDOR) and status-guarded (only PENDING/WAITING_VERIFICATION,
   * so a PAID/FAILED/EXPIRED/REFUNDED payment can never be reverted). Mirrors the
   * tokenized path via the shared applyReceiptInTx.
   */
  async uploadManualReceipt(paymentId: string, userId: string, dto: UploadManualPaymentDto): Promise<Payment> {
    await this.assertPaymentOwner(paymentId, userId);
    return this.prisma.$transaction(
      (tx) => this.applyReceiptInTx(tx, paymentId, dto, 'payments.uploadManualReceipt'),
      { timeout: 10000 },
    );
  }

  /** Generic 404 when the payment is missing or not owned by the caller (no enumeration). */
  async assertPaymentOwner(paymentId: string, userId: string): Promise<void> {
    const owned = await this.prisma.payment.findFirst({
      where: { id: paymentId, deletedAt: null, order: { userId } },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('Payment not found');
  }

  /**
   * Shared receipt application: a status-guarded CAS move to WAITING_VERIFICATION
   * plus the payment.receipt_uploaded event, atomically. A terminal payment fails
   * the CAS → 409 (and the caller's transaction rolls back).
   */
  private async applyReceiptInTx(
    tx: Prisma.TransactionClient,
    paymentId: string,
    dto: UploadManualPaymentDto,
    source: string,
  ): Promise<Payment> {
    const flip = await tx.payment.updateMany({
      where: { id: paymentId, status: { in: UPLOADABLE_STATUSES } },
      data: {
        status: PaymentStatus.WAITING_VERIFICATION,
        manualReceiptUrl: dto.receiptUrl,
        manualBankName: dto.bankName,
        manualAccountName: dto.accountName,
      },
    });
    if (flip.count !== 1) {
      throw new ConflictException('This order is no longer awaiting a payment receipt');
    }
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    await tx.outboxEvent.create({
      data: {
        id: randomUUID(),
        aggregateType: 'payment',
        aggregateId: payment.id,
        eventName: 'payment.receipt_uploaded',
        eventVersion: 1,
        exchange: 'payments',
        routingKey: 'payment.receipt_uploaded',
        payload: { paymentId: payment.id, orderId: payment.orderId },
        metadata: { source },
        occurredAt: new Date(),
      },
    });
    return payment;
  }

  /**
   * Public upload-landing data for a tokenized link (no auth). Generic 404 on any
   * invalid/used/expired token or missing payment so a token cannot be used to
   * probe for payments (no enumeration). A terminal/blocked status is a 409.
   */
  async getUploadPage(rawToken: string) {
    const token = await this.uploadTokens.resolveActive(rawToken);
    if (!token) throw new NotFoundException('Upload link is invalid or has expired');

    const payment = await this.prisma.payment.findUnique({
      where: { id: token.paymentId },
      include: { order: { select: { orderNumber: true } } },
    });
    if (!payment || payment.deletedAt) throw new NotFoundException('Upload link is invalid or has expired');
    if (!UPLOADABLE_STATUSES.includes(payment.status)) {
      throw new ConflictException(`This order is no longer awaiting a payment receipt (status ${payment.status})`);
    }

    return {
      orderNumber: payment.order.orderNumber,
      amount: payment.amount,
      // Manual BANK_TRANSFER unique code (folded into `amount`); null for QRIS/legacy.
      uniqueCode: payment.uniqueCode ?? null,
      method: payment.method,
      bankName: payment.manualBankName,
      status: payment.status,
    };
  }

  /**
   * Public, unauthenticated receipt submission via a single-use token. One atomic
   * transaction: consume the token (CAS), move the payment to WAITING_VERIFICATION
   * (status-guarded), and emit payment.receipt_uploaded exactly once. A replay (used
   * token), an expired token, or a terminal payment status rolls the whole tx back,
   * so neither the token nor the event is half-applied.
   */
  async submitReceiptByToken(rawToken: string, dto: UploadManualPaymentDto): Promise<Payment> {
    return this.prisma.$transaction(async (tx) => {
      const { consumed, paymentId } = await this.uploadTokens.consume(tx, rawToken);
      if (!consumed || !paymentId) {
        // Normalized with GET: a missing/used/expired token is a uniform 404 so a
        // used token is indistinguishable from an invalid one (no enumeration).
        throw new NotFoundException('Upload link is invalid, already used, or expired');
      }
      return this.applyReceiptInTx(tx, paymentId, dto, 'payments.submitReceiptByToken');
    }, { timeout: 10000 });
  }
}
