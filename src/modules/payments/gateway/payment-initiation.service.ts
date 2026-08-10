import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { GatewayTransactionStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { LogService } from '../../../infrastructure/logging/log.service';
import { PaymentChannelDescriptor } from './domain/payment-channel';
import { ChargeResult, ProviderStatus } from './domain/payment-provider.interface';
import { CheckoutGatewayPayload, buildGatewayPayloadFromLedger } from './domain/payment-instruction.builder';
import { PaymentGatewayPersistenceService } from './payment-gateway-persistence.service';
import { PaymentChannelRegistry } from './payment-channel.registry';
import { PaymentProviderFactory } from './payment-provider.factory';

/** Provider name assumed for rows created before gateways existed (Payment.provider is null). */
const DEFAULT_PROVIDER = 'manual';

const TERMINAL: PaymentStatus[] = [PaymentStatus.PAID, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.REFUNDED];

/**
 * The single seam between business code and payment providers.
 *
 * Phase 2 flow: validate payment → resolve channel → open a PENDING ledger row →
 * call the provider → persist the provider response → return the ChargeResult.
 *
 * It writes ONLY to PaymentGatewayTransaction. The `Payment` row is never touched
 * here: moving a payment to PAID/FAILED remains the exclusive job of the existing
 * CAS-guarded flows (admin verify/reject, expiry worker). Nothing calls
 * `initiate()` yet — no endpoint is exposed until a later phase — so the live
 * manual-transfer flow is completely unaffected.
 */
@Injectable()
export class PaymentInitiationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: PaymentChannelRegistry,
    private readonly providers: PaymentProviderFactory,
    private readonly ledger: PaymentGatewayPersistenceService,
    @Optional() private readonly logs?: LogService,
  ) {}

  /**
   * Open (or describe) the charge for an existing payment on the chosen channel.
   * Guards: payment exists, is not terminal, and the channel's business method
   * matches the method the order was placed with — a BANK_TRANSFER payment can
   * never be switched to a gateway channel behind the order's back.
   */
  async initiate(paymentId: string, channelCode: string): Promise<ChargeResult> {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, deletedAt: null },
      select: {
        id: true,
        orderId: true,
        method: true,
        status: true,
        amount: true,
        order: {
          select: {
            orderNumber: true,
            user: { select: { name: true, email: true, phone: true } },
          },
        },
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (TERMINAL.includes(payment.status)) {
      throw new ConflictException(`Payment is already ${payment.status} and cannot be initiated`);
    }

    const { channel, provider } = this.channels.resolve(channelCode);
    this.assertMethodMatches(channel, payment.method);

    // 3. Open the ledger row BEFORE calling the provider, so a charge that
    //    succeeds at the gateway but crashes on the way back is still traceable
    //    (the same "record the attempt first" rule the outbox and shipment
    //    booking claim already follow). Idempotent per payment+provider+channel.
    const transaction = await this.ledger.createPendingTransaction({
      paymentId: payment.id,
      provider: provider.name,
      channelCode: channel.code,
      grossAmount: payment.amount,
      providerOrderId: payment.order.orderNumber,
      metadata: { method: payment.method, channel: channel.code },
    });

    // 4. Call the provider (manual transfer performs no external I/O).
    let result: ChargeResult;
    try {
      result = await provider.createCharge({
        paymentId: payment.id,
        orderId: payment.orderId,
        orderNumber: payment.order.orderNumber,
        amount: payment.amount,
        channel: channel.code,
        customer: {
          name: payment.order.user?.name ?? null,
          email: payment.order.user?.email ?? null,
          phone: payment.order.user?.phone ?? null,
        },
        // Lets a provider key its charge per ATTEMPT (Midtrans rejects a repeated
        // order_id), so a retry or channel switch can never collide.
        attemptId: transaction.id,
      });
    } catch (err) {
      // 5a. Record the failure on the attempt, then rethrow untouched so the
      //     caller's error contract is unchanged.
      const message = err instanceof Error ? err.message : String(err);
      await this.ledger.markFailed(transaction.id, message).catch(() => undefined);
      throw err;
    }

    // 5b. Persist what the provider returned.
    await this.ledger.updateGatewayResponse(transaction.id, {
      status: result.providerStatus ?? GatewayTransactionStatus.PENDING,
      // 5A: replace the placeholder written at step 3 with the id the provider
      // actually charged. Taken verbatim from the provider — never rebuilt here,
      // so GatewayTransaction.providerOrderId === the gateway's order_id exactly.
      ...(result.providerOrderId ? { providerOrderId: result.providerOrderId } : {}),
      providerReference: result.providerReference ?? null,
      providerTransactionId: result.providerTransactionId ?? null,
      redirectUrl: result.instructions.actionUrl ?? null,
      deeplinkUrl: result.instructions.kind === 'DEEPLINK' ? result.instructions.actionUrl ?? null : null,
      qrString: result.instructions.qrString ?? null,
      vaNumber: result.instructions.vaNumber ?? null,
      expiryAt: result.expiresAt,
      ...(result.metadata ? { metadata: result.metadata as Prisma.InputJsonValue } : {}),
      ...(result.raw !== undefined ? { rawResponse: result.raw as Prisma.InputJsonValue } : {}),
    });

    this.logs?.write({
      level: 'INFO',
      module: 'payments.gateway',
      action: 'payment.initiate',
      message: `charge described via ${provider.name}/${channel.code}`,
      paymentId: payment.id,
      orderId: payment.orderId,
      metadata: { provider: provider.name, channel: channel.code, status: result.status, gatewayTransactionId: transaction.id },
    });

    return result;
  }

  /**
   * Rebuild the payment instructions for an OPEN attempt from the ledger — used
   * by the payment-detail page on load/refresh. Read-only: no provider call, so
   * refreshing can never open a second charge. Ownership-scoped (generic 404).
   */
  async getInstructions(paymentId: string, userId: string): Promise<CheckoutGatewayPayload | null> {
    const owned = await this.prisma.payment.findFirst({
      where: { id: paymentId, deletedAt: null, order: { userId } },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('Payment not found');

    const attempt = await this.ledger.findLatestByPayment(paymentId);
    if (!attempt) return null; // manual transfer or never initiated

    const descriptor = this.channels.find(attempt.channelCode);
    if (!descriptor) return null;

    return buildGatewayPayloadFromLedger(attempt, descriptor);
  }

  /** Read the authoritative status from whichever provider owns this payment. */
  async refreshStatus(paymentId: string): Promise<ProviderStatus> {
    const { provider, ref } = await this.resolveOwner(paymentId);
    return provider.getStatus(ref);
  }

  /** Ask the owning provider to void an open charge. */
  async cancel(paymentId: string): Promise<ProviderStatus> {
    const { provider, ref } = await this.resolveOwner(paymentId);
    return provider.cancel(ref);
  }

  /** Payment.provider is null for every pre-gateway row → manual owns it. */
  private async resolveOwner(paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, deletedAt: null },
      select: { id: true, provider: true, providerReference: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');

    const name = payment.provider ?? DEFAULT_PROVIDER;
    const provider = this.providers.get(name);
    if (!provider) throw new NotFoundException(`Payment provider '${name}' is not registered`);

    return { provider, ref: { paymentId: payment.id, providerReference: payment.providerReference } };
  }

  private assertMethodMatches(channel: PaymentChannelDescriptor, method: PaymentMethod): void {
    if (channel.method !== method) {
      throw new ConflictException(
        `Channel '${channel.code}' cannot be used for a ${method} payment`,
      );
    }
  }
}
