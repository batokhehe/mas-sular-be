import { GatewayTransactionStatus, PaymentStatus } from '@prisma/client';
import { PaymentChannelCode } from './payment-channel';

/**
 * Identifies a payment at a provider. `providerReference` is the gateway's own id
 * (Midtrans transaction_id, Xendit invoice id, …) and is null for manual transfer,
 * which has no external counterpart.
 */
export interface PaymentRef {
  paymentId: string;
  providerReference?: string | null;
}

/** Everything a provider needs to open a charge. Built by the orchestrator, never by a controller. */
export interface ChargeRequest {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  /** Final amount the customer must pay (manual transfer: already includes the unique code). */
  amount: number;
  channel: PaymentChannelCode;
  customer: { name: string | null; email: string | null; phone: string | null };
  /** Provider-facing expiry hint; null means "provider default". */
  expiresAt?: Date | null;
  /**
   * Ledger attempt id (PaymentGatewayTransaction.id). Providers that key charges
   * by a merchant-side reference use it to keep every attempt unique, so a retry
   * or channel switch can never collide with a previous charge.
   */
  attemptId?: string;
  /**
   * Channel-specific inputs the generic contract cannot model — e.g. a browser
   * card token for CREDIT_CARD, or an e-wallet callback URL.
   */
  channelParams?: Record<string, unknown>;
}

/**
 * What the customer is shown to complete the payment. `kind` drives which UI the
 * storefront renders; every other field is optional and channel-specific.
 */
export interface PaymentInstructions {
  kind: 'MANUAL_TRANSFER' | 'VA' | 'QR' | 'DEEPLINK' | 'REDIRECT';
  amount: number;
  /** MANUAL_TRANSFER / VA */
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  /** MANUAL_TRANSFER only — the 3-digit code already folded into `amount`. */
  uniqueCode?: number | null;
  /** VA */
  vaNumber?: string;
  /** QR */
  qrString?: string;
  qrImageUrl?: string;
  /** DEEPLINK / REDIRECT */
  actionUrl?: string;
  /** Human steps, rendered as an ordered list. Customer-facing copy only. */
  howTo: string[];
}

/** Outcome of opening a charge. */
export interface ChargeResult {
  provider: string;
  channel: PaymentChannelCode;
  providerReference: string | null;
  /** Business status — unchanged vocabulary the rest of the system already speaks. */
  status: PaymentStatus;
  instructions: PaymentInstructions;
  expiresAt: Date | null;
  /** Raw provider response for the ledger (Phase 2+). Redact before persisting. */
  raw?: unknown;

  // --- Ledger fields (Phase 2). Optional so any provider may omit what it lacks. ---
  /**
   * The merchant-side order id the provider was actually charged with (Midtrans
   * `order_id`). It is generated INSIDE the provider (per attempt), so it is
   * returned here and persisted verbatim — never reconstructed by the caller.
   * Providers with no such concept (manual transfer) omit it.
   */
  providerOrderId?: string | null;
  /** Provider's own transaction id, when distinct from providerReference. */
  providerTransactionId?: string | null;
  /** PROVIDER-level status recorded on the ledger row (never on Payment). */
  providerStatus?: GatewayTransactionStatus;
  /** Structured, non-secret context worth keeping with the attempt. */
  metadata?: Record<string, unknown>;
  /** Redacted snapshot of what we sent the provider. */
  rawRequest?: unknown;
}

/** Authoritative status read back from a provider. */
export interface ProviderStatus {
  provider: string;
  providerReference: string | null;
  status: PaymentStatus;
  raw?: unknown;
}

/**
 * A payment integration. New providers (Midtrans, Xendit, DOKU, Tripay, …)
 * implement this interface and are appended to the PAYMENT_PROVIDERS list in
 * PaymentGatewayModule — OrdersService, AdminService, and the checkout never
 * change (see PaymentProviderFactory). Mirrors ShippingProvider by design.
 */
export interface PaymentProvider {
  /** Machine name persisted to Payment.provider, e.g. 'manual', 'midtrans'. Never shown to customers. */
  readonly name: string;

  /** Channels this provider can serve. The registry uses this to bind channel → provider. */
  supportedChannels(): PaymentChannelCode[];

  /** Open a charge for an existing Payment row. Must be idempotent per paymentId. */
  createCharge(request: ChargeRequest): Promise<ChargeResult>;

  /** Read the authoritative current status from the provider. */
  getStatus(ref: PaymentRef): Promise<ProviderStatus>;

  /** Cancel/void an open charge. Providers that cannot cancel throw. */
  cancel(ref: PaymentRef): Promise<ProviderStatus>;

  /** Translate a provider-specific status string into our PaymentStatus vocabulary. */
  mapStatus(providerStatus: string): PaymentStatus;

  /**
   * Force-expire an open charge. OPTIONAL: gateways that expose it (Midtrans)
   * implement it; manual transfer has no such concept and omits it, so adding
   * this never breaks an existing provider.
   */
  expireCharge?(ref: PaymentRef): Promise<ProviderStatus>;
}
