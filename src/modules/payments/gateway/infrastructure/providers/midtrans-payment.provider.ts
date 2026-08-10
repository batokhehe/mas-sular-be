import { Inject, Injectable, Logger } from '@nestjs/common';
import { GatewayTransactionStatus, PaymentStatus } from '@prisma/client';
import { mapGatewayStatusToPaymentStatus } from '../../domain/gateway-status.mapper';
import {
  buildHowTo,
  extractChannelArtifacts,
  MidtransChargeResponse,
  midtransSpecFor,
  midtransSupportedChannels,
} from '../../domain/midtrans-channel.map';
import { PaymentChannelCode } from '../../domain/payment-channel';
import { PermanentGatewayError } from '../../domain/payment-gateway-errors';
import {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
  PaymentRef,
  ProviderStatus,
} from '../../domain/payment-provider.interface';
import { MIDTRANS_CONFIG, MidtransConfig } from '../../midtrans.config';
import {
  defaultMidtransHttpClient,
  executeMidtransRequest,
  MidtransHttpClient,
} from '../http/midtrans-http.client';

/**
 * Translate Midtrans `transaction_status` (+ `fraud_status`) into our provider
 * vocabulary. Exported for direct testing; the webhook receiver (Phase 4) will
 * reuse it so charge and callback can never disagree.
 */
export function mapMidtransStatus(transactionStatus?: string, fraudStatus?: string): GatewayTransactionStatus {
  switch ((transactionStatus ?? '').toLowerCase()) {
    case 'capture':
      // A captured card held for manual fraud review is NOT settled money.
      if (fraudStatus === 'challenge') return GatewayTransactionStatus.AUTHORIZED;
      if (fraudStatus === 'deny') return GatewayTransactionStatus.FAILED;
      return GatewayTransactionStatus.CAPTURED;
    case 'settlement':
      return GatewayTransactionStatus.SETTLEMENT;
    case 'authorize':
      return GatewayTransactionStatus.AUTHORIZED;
    case 'pending':
      return GatewayTransactionStatus.PENDING;
    case 'deny':
    case 'failure':
      return GatewayTransactionStatus.FAILED;
    case 'cancel':
      return GatewayTransactionStatus.CANCELLED;
    case 'expire':
      return GatewayTransactionStatus.EXPIRED;
    case 'refund':
    case 'partial_refund':
      return GatewayTransactionStatus.REFUNDED;
    default:
      // Unknown vocabulary must never be optimistically treated as paid.
      return GatewayTransactionStatus.PENDING;
  }
}

/**
 * Midtrans Core API integration.
 *
 * HTTP AND MAPPING ONLY — no persistence, no business rules, no Payment writes.
 * The orchestrator (PaymentInitiationService) owns the ledger; this class turns a
 * ChargeRequest into a Midtrans call and the response into a ChargeResult.
 *
 * Registered only when MIDTRANS_ENABLED=true, so with the flag off the provider
 * is absent from the factory and its channels can never become available.
 */
@Injectable()
export class MidtransPaymentProvider implements PaymentProvider {
  readonly name = 'midtrans';
  private readonly logger = new Logger('MidtransPaymentProvider');
  private http: MidtransHttpClient = defaultMidtransHttpClient;

  constructor(@Inject(MIDTRANS_CONFIG) private readonly config: MidtransConfig) {}

  /** Test seam — swap the transport without touching the provider logic. */
  setHttpClient(client: MidtransHttpClient): void {
    this.http = client;
  }

  supportedChannels(): PaymentChannelCode[] {
    return midtransSupportedChannels();
  }

  async createCharge(request: ChargeRequest): Promise<ChargeResult> {
    const spec = midtransSpecFor(request.channel);
    if (!spec) {
      throw new PermanentGatewayError(`channel '${request.channel}' is not a Midtrans channel`, this.name);
    }
    if (spec.requiresCardToken && !request.channelParams?.cardTokenId) {
      // Card data never touches our servers: the browser SDK mints the token.
      throw new PermanentGatewayError('a card token is required for CREDIT_CARD charges', this.name);
    }

    // Unique per ATTEMPT: Midtrans rejects a repeated order_id (406), which is
    // what makes a channel switch or retry safe rather than a double charge.
    const orderId = this.buildOrderId(request);

    const body = {
      payment_type: spec.paymentType,
      transaction_details: { order_id: orderId, gross_amount: request.amount },
      customer_details: {
        first_name: request.customer.name ?? undefined,
        email: request.customer.email ?? undefined,
        phone: request.customer.phone ?? undefined,
      },
      ...spec.buildPayload({
        cardTokenId: request.channelParams?.cardTokenId as string | undefined,
        callbackUrl: request.channelParams?.callbackUrl as string | undefined,
        billInfo: { info1: 'Pembayaran', info2: request.orderNumber },
      }),
    };

    const response = await this.send<MidtransChargeResponse>('POST', '/v2/charge', body, {
      idempotencyKey: orderId,
      logBase: { op: 'charge', channel: request.channel, orderId },
    });

    const artifacts = extractChannelArtifacts(request.channel, response);
    const providerStatus = mapMidtransStatus(response.transaction_status, response.fraud_status);

    return {
      provider: this.name,
      channel: request.channel,
      providerReference: response.transaction_id ?? null,
      // The EXACT value sent as transaction_details.order_id — the webhook's
      // correlation key (it is what Midtrans signs and echoes back).
      providerOrderId: orderId,
      providerTransactionId: response.transaction_id ?? null,
      providerStatus,
      // Business status stays conservative: a fresh charge is never "paid" here.
      // Settlement is confirmed by the webhook/sync flow in a later phase.
      status: mapGatewayStatusToPaymentStatus(providerStatus),
      expiresAt: this.parseExpiry(response.expiry_time),
      instructions: {
        kind: spec.instructionKind,
        amount: request.amount,
        ...(artifacts.vaNumber ? { vaNumber: artifacts.vaNumber } : {}),
        ...(artifacts.qrString ? { qrString: artifacts.qrString } : {}),
        ...(artifacts.deeplinkUrl || artifacts.redirectUrl
          ? { actionUrl: artifacts.deeplinkUrl ?? artifacts.redirectUrl }
          : {}),
        howTo: buildHowTo(request.channel, artifacts),
      },
      metadata: {
        source: 'midtrans',
        paymentType: response.payment_type ?? spec.paymentType,
        orderId,
        fraudStatus: response.fraud_status ?? null,
        transactionStatus: response.transaction_status ?? null,
      },
      rawRequest: this.redactRequest(body),
      raw: response,
    };
  }

  async getStatus(ref: PaymentRef): Promise<ProviderStatus> {
    const key = this.requireProviderKey(ref, 'status');
    const response = await this.send<MidtransChargeResponse>('GET', `/v2/${encodeURIComponent(key)}/status`, undefined, {
      logBase: { op: 'status', key },
    });
    return this.toProviderStatus(response, key);
  }

  /** Void an open charge (PaymentProvider contract). */
  async cancel(ref: PaymentRef): Promise<ProviderStatus> {
    const key = this.requireProviderKey(ref, 'cancel');
    const response = await this.send<MidtransChargeResponse>('POST', `/v2/${encodeURIComponent(key)}/cancel`, undefined, {
      logBase: { op: 'cancel', key },
    });
    return this.toProviderStatus(response, key);
  }

  /** Force-expire an unpaid charge — Midtrans-specific, optional on the interface. */
  async expireCharge(ref: PaymentRef): Promise<ProviderStatus> {
    const key = this.requireProviderKey(ref, 'expire');
    const response = await this.send<MidtransChargeResponse>('POST', `/v2/${encodeURIComponent(key)}/expire`, undefined, {
      logBase: { op: 'expire', key },
    });
    return this.toProviderStatus(response, key);
  }

  mapStatus(providerStatus: string): PaymentStatus {
    return mapGatewayStatusToPaymentStatus(mapMidtransStatus(providerStatus));
  }

  // ------------------------------------------------------------- internals --

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    opts: { idempotencyKey?: string; logBase: Record<string, unknown> },
  ): Promise<T> {
    if (!this.config.serverKey) {
      throw new PermanentGatewayError('MIDTRANS_SERVER_KEY is not configured', this.name);
    }
    const response = await executeMidtransRequest<T>({
      http: this.http,
      url: `${this.config.baseUrl}${path}`,
      init: {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          // Server key as HTTP Basic username, empty password (Midtrans spec).
          Authorization: `Basic ${Buffer.from(`${this.config.serverKey}:`).toString('base64')}`,
          // Sent on every call; Midtrans's documented duplicate protection is
          // order_id uniqueness, so this header is belt-and-braces, not the
          // primary guarantee.
          ...(opts.idempotencyKey ? { 'X-Idempotency-Key': opts.idempotencyKey } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        timeoutMs: this.config.timeoutMs,
      },
      maxRetry: this.config.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, ...opts.logBase },
    });

    this.assertBodyOk(response);
    return response;
  }

  /**
   * Midtrans can answer HTTP 200 while reporting a 4xx/5xx in `status_code`.
   * Treat that as permanent — the charge was rejected, retrying repeats it.
   */
  private assertBodyOk(response: unknown): void {
    const code = (response as MidtransChargeResponse)?.status_code;
    if (typeof code === 'string' && /^[45]/.test(code)) {
      const message = (response as MidtransChargeResponse).status_message ?? 'rejected';
      throw new PermanentGatewayError(`midtrans status_code ${code}: ${message}`, this.name);
    }
  }

  private toProviderStatus(response: MidtransChargeResponse, key: string): ProviderStatus {
    return {
      provider: this.name,
      providerReference: response.transaction_id ?? key,
      status: mapGatewayStatusToPaymentStatus(mapMidtransStatus(response.transaction_status, response.fraud_status)),
      raw: response,
    };
  }

  /** Midtrans keys every operation off order_id / transaction_id — our paymentId is meaningless to it. */
  private requireProviderKey(ref: PaymentRef, op: string): string {
    if (!ref.providerReference) {
      throw new PermanentGatewayError(`cannot ${op}: no Midtrans reference recorded for this payment`, this.name);
    }
    return ref.providerReference;
  }

  private buildOrderId(request: ChargeRequest): string {
    const suffix = request.attemptId ? `-${request.attemptId.replace(/-/g, '').slice(0, 8)}` : '';
    return `${request.orderNumber}${suffix}`.slice(0, 50); // Midtrans order_id limit
  }

  private parseExpiry(raw?: string): Date | null {
    if (!raw) return null;
    // Midtrans returns "YYYY-MM-DD HH:mm:ss" in the merchant's timezone (WIB).
    const parsed = new Date(raw.replace(' ', 'T') + '+07:00');
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  /** Card data must never reach our logs or the ledger's rawRequest snapshot. */
  private redactRequest(body: Record<string, unknown>): Record<string, unknown> {
    const clone = { ...body } as Record<string, unknown>;
    if (clone.credit_card) clone.credit_card = { token_id: '[REDACTED]', authentication: true };
    return clone;
  }
}
