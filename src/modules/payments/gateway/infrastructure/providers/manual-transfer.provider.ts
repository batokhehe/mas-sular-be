import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { GatewayTransactionStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../../../../database/prisma.service';
import { PaymentAccountService } from '../../../../payment-accounts/payment-account.service';
import { PaymentChannelCode } from '../../domain/payment-channel';
import {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
  PaymentRef,
  ProviderStatus,
} from '../../domain/payment-provider.interface';

const TERMINAL: PaymentStatus[] = [PaymentStatus.PAID, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.REFUNDED];

/**
 * Manual bank transfer as a first-class PaymentProvider.
 *
 * This is an ADAPTER, not a reimplementation: the real manual flow (unique-code
 * allocation at checkout, single-use upload token, receipt submission, admin
 * verification, reminders, expiry) is untouched and continues to live in
 * OrdersService / PaymentsService / PaymentLifecycleWorker.
 *
 * Consequently `createCharge()` performs NO writes — the Payment row already
 * exists (created inside the checkout transaction) and the active bank account is
 * read from the existing PaymentAccountService. It only DESCRIBES how to pay,
 * which is what a gateway's charge call returns. That keeps this phase inert.
 */
@Injectable()
export class ManualTransferProvider implements PaymentProvider {
  readonly name = 'manual';

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: PaymentAccountService,
  ) {}

  supportedChannels(): PaymentChannelCode[] {
    return ['MANUAL_TRANSFER'];
  }

  /**
   * Describe the transfer the customer must make. Read-only: no row is created or
   * mutated, so calling this can never alter the existing manual-transfer flow.
   * Propagates ConfigurationError when no active bank account is configured —
   * the same non-retryable error the notification builder already relies on.
   */
  async createCharge(request: ChargeRequest): Promise<ChargeResult> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: request.paymentId },
      select: { status: true, uniqueCode: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');

    const account = await this.accounts.getActiveAccount();

    const howTo = [
      `Transfer tepat sebesar Rp ${request.amount.toLocaleString('id-ID')} ke rekening ${account.bankName} berikut.`,
      `Rekening ${account.accountNumber} atas nama ${account.accountName}.`,
      ...(payment.uniqueCode !== null
        ? [`Nominal sudah termasuk kode unik ${payment.uniqueCode}. Transfer sesuai nominal agar pembayaran otomatis dikenali.`]
        : []),
      'Unggah bukti transfer melalui tautan pembayaran, lalu tunggu verifikasi admin.',
    ];

    return {
      provider: this.name,
      channel: 'MANUAL_TRANSFER',
      // No external gateway exists, so the payment's own id IS the stable handle
      // for this attempt. Filling these keeps the ledger row shape identical to a
      // real provider's (Phase 2 contract) without inventing a fake reference.
      providerReference: request.paymentId,
      providerTransactionId: request.paymentId,
      providerStatus: GatewayTransactionStatus.PENDING,
      status: payment.status, // unchanged — the checkout already set PENDING
      expiresAt: null, // expiry is owned by PaymentLifecycleWorker, not this provider
      metadata: {
        source: 'manual-transfer',
        bankName: account.bankName,
        bankCode: account.bankCode,
        accountNumber: account.accountNumber,
        uniqueCode: payment.uniqueCode,
      },
      instructions: {
        kind: 'MANUAL_TRANSFER',
        amount: request.amount,
        bankName: account.bankName,
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        uniqueCode: payment.uniqueCode,
        howTo,
      },
    };
  }

  /** For manual transfer WE are the source of truth: read the row back. */
  async getStatus(ref: PaymentRef): Promise<ProviderStatus> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: ref.paymentId },
      select: { status: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return { provider: this.name, providerReference: null, status: payment.status };
  }

  /**
   * Manual transfer has no gateway charge to void. Cancellation is a business
   * transition owned by the existing admin-reject and payment-expiry flows (both
   * CAS-guarded and restock-aware); duplicating it here would fork that logic.
   */
  async cancel(ref: PaymentRef): Promise<ProviderStatus> {
    const current = await this.getStatus(ref);
    if (TERMINAL.includes(current.status)) return current; // already final — idempotent no-op
    throw new BadRequestException(
      'Manual transfer payments are cancelled by admin rejection or automatic expiry, not by the payment provider',
    );
  }

  /** No external vocabulary to translate — validate and pass through. */
  mapStatus(providerStatus: string): PaymentStatus {
    const known = Object.values(PaymentStatus) as string[];
    return known.includes(providerStatus) ? (providerStatus as PaymentStatus) : PaymentStatus.PENDING;
  }
}
