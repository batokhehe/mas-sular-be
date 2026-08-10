import { PaymentMethod } from '@prisma/client';

/**
 * Customer-facing payment channels. A channel is a PRESENTATION concept and an
 * implementation detail of a provider — it is deliberately NOT a Prisma enum and
 * never reaches OrdersService, which knows only PaymentMethod (BANK_TRANSFER /
 * GATEWAY). Adding a bank or e-wallet is a catalog entry, not a migration.
 */
export type PaymentChannelCode =
  | 'MANUAL_TRANSFER'
  | 'QRIS'
  | 'GOPAY'
  | 'SHOPEEPAY'
  | 'BCA_VA'
  | 'BNI_VA'
  | 'BRI_VA'
  | 'MANDIRI_BILL'
  | 'PERMATA_VA'
  | 'CREDIT_CARD';

export type PaymentChannelGroup = 'MANUAL' | 'QR' | 'EWALLET' | 'VIRTUAL_ACCOUNT' | 'CARD';

export interface PaymentChannelDescriptor {
  code: PaymentChannelCode;
  /** Customer-facing label. NEVER contains a provider/gateway name. */
  label: string;
  group: PaymentChannelGroup;
  /** Infrastructure detail — the provider that serves this channel. Never sent to customers. */
  provider: string;
  /** Business method persisted on Payment.method. */
  method: PaymentMethod;
  logoUrl: string | null;
  /** Static intent flag. Availability additionally requires a registered provider. */
  enabled: boolean;
  description?: string;

  // --- Presentation metadata (Phase 4). The storefront renders from these; it
  //     must never hardcode a payment list. ---
  /** Semantic icon key the UI maps to its own asset/emoji. */
  icon: string;
  /** Ascending display order within a group. */
  sortOrder: number;
  /** Badge: the merchant's preferred option. */
  recommended?: boolean;
  /** Badge: most used by customers. */
  popular?: boolean;
  /** Badge: confirms automatically (no manual verification). */
  instant?: boolean;
}

/** The customer-visible projection: provider is stripped, method is kept (checkout needs it). */
export interface PublicPaymentChannel {
  code: PaymentChannelCode;
  label: string;
  group: PaymentChannelGroup;
  method: PaymentMethod;
  logoUrl: string | null;
  description?: string;
  icon: string;
  sortOrder: number;
  recommended?: boolean;
  popular?: boolean;
  instant?: boolean;
}

/**
 * Hardcoded catalog (Phase 1 — no database by design; PaymentChannelConfig arrives
 * in a later phase and will only override label/logo/order/enabled).
 *
 * Gateway channels are intent-enabled, but availability ALSO requires their
 * provider to be registered — and MidtransPaymentProvider registers only when
 * MIDTRANS_ENABLED=true. With the flag off (the default) the catalog resolves to
 * manual transfer alone, exactly as before. `enabled: false` remains the
 * per-channel kill switch (e.g. GoPay is down).
 *
 * `logoUrl` is null until the asset set lands (Phase 5/6) — a wrong path would
 * render broken images in checkout.
 */
export const PAYMENT_CHANNELS: readonly PaymentChannelDescriptor[] = [
  {
    code: 'MANUAL_TRANSFER',
    icon: 'bank',
    sortOrder: 10,
    recommended: true,
    label: 'Transfer Bank',
    group: 'MANUAL',
    provider: 'manual',
    method: PaymentMethod.BANK_TRANSFER,
    logoUrl: null,
    enabled: true,
    description: 'Transfer manual ke rekening kami, lalu unggah bukti pembayaran.',
  },
  {
    code: 'QRIS',
    icon: 'qris',
    sortOrder: 20,
    popular: true,
    instant: true,
    label: 'QRIS',
    group: 'QR',
    provider: 'midtrans',
    method: PaymentMethod.GATEWAY,
    logoUrl: null,
    enabled: true,
    description: 'Bayar dengan memindai kode QR dari aplikasi bank atau e-wallet apa pun.',
  },
  {
    code: 'GOPAY',
    icon: 'gopay',
    sortOrder: 30,
    popular: true,
    instant: true,
    label: 'GoPay',
    group: 'EWALLET',
    provider: 'midtrans',
    method: PaymentMethod.GATEWAY,
    logoUrl: null,
    enabled: true,
  },
  {
    code: 'SHOPEEPAY',
    icon: 'shopeepay',
    sortOrder: 31,
    instant: true,
    label: 'ShopeePay',
    group: 'EWALLET',
    provider: 'midtrans',
    method: PaymentMethod.GATEWAY,
    logoUrl: null,
    enabled: true,
  },
  {
    code: 'BCA_VA',
    icon: 'bca',
    sortOrder: 40,
    popular: true,
    instant: true,
    label: 'BCA Virtual Account',
    group: 'VIRTUAL_ACCOUNT',
    provider: 'midtrans',
    method: PaymentMethod.GATEWAY,
    logoUrl: null,
    enabled: true,
  },
  {
    code: 'BNI_VA',
    icon: 'bni',
    sortOrder: 41,
    instant: true,
    label: 'BNI Virtual Account',
    group: 'VIRTUAL_ACCOUNT',
    provider: 'midtrans',
    method: PaymentMethod.GATEWAY,
    logoUrl: null,
    enabled: true,
  },
  {
    code: 'BRI_VA',
    icon: 'bri',
    sortOrder: 42,
    instant: true,
    label: 'BRI Virtual Account',
    group: 'VIRTUAL_ACCOUNT',
    provider: 'midtrans',
    method: PaymentMethod.GATEWAY,
    logoUrl: null,
    enabled: true,
  },
  {
    code: 'MANDIRI_BILL',
    icon: 'mandiri',
    sortOrder: 43,
    instant: true,
    label: 'Mandiri Virtual Account',
    group: 'VIRTUAL_ACCOUNT',
    provider: 'midtrans',
    method: PaymentMethod.GATEWAY,
    logoUrl: null,
    enabled: true,
  },
  {
    code: 'PERMATA_VA',
    icon: 'permata',
    sortOrder: 44,
    instant: true,
    label: 'Permata Virtual Account',
    group: 'VIRTUAL_ACCOUNT',
    provider: 'midtrans',
    method: PaymentMethod.GATEWAY,
    logoUrl: null,
    enabled: true,
  },
  {
    code: 'CREDIT_CARD',
    icon: 'card',
    sortOrder: 50,
    instant: true,
    label: 'Kartu Kredit / Debit',
    group: 'CARD',
    provider: 'midtrans',
    method: PaymentMethod.GATEWAY,
    logoUrl: null,
    enabled: true,
  },
];

/** Strip infrastructure details before a descriptor crosses the API boundary. */
export function toPublicChannel(descriptor: PaymentChannelDescriptor): PublicPaymentChannel {
  return {
    code: descriptor.code,
    label: descriptor.label,
    group: descriptor.group,
    method: descriptor.method,
    logoUrl: descriptor.logoUrl,
    icon: descriptor.icon,
    sortOrder: descriptor.sortOrder,
    ...(descriptor.description ? { description: descriptor.description } : {}),
    ...(descriptor.recommended ? { recommended: true } : {}),
    ...(descriptor.popular ? { popular: true } : {}),
    ...(descriptor.instant ? { instant: true } : {}),
  };
}

/**
 * Payment methods a customer may select for a NEW order — the SINGLE source of
 * truth, derived from the channel catalog itself (Phase 4A).
 *
 * COD is deliberately absent: it is offered by no channel, so it can never be
 * selected again. Historical COD orders/payments are untouched and stay fully
 * readable — this gate only guards CREATION.
 *
 * `QRIS` is retained as a LEGACY exception: it is the pre-gateway manual
 * QRIS-with-receipt method, still accepted so existing integrations keep working.
 * It is not in the catalog, so the storefront no longer offers it.
 */
const LEGACY_SELECTABLE_METHODS: readonly PaymentMethod[] = [PaymentMethod.QRIS];

export function selectablePaymentMethods(): PaymentMethod[] {
  const fromCatalog = PAYMENT_CHANNELS.map((channel) => channel.method);
  return [...new Set([...fromCatalog, ...LEGACY_SELECTABLE_METHODS])];
}

export function isSelectablePaymentMethod(method: PaymentMethod): boolean {
  return selectablePaymentMethods().includes(method);
}

/** The method used when a client omits one. Manual transfer — never COD. */
export const DEFAULT_PAYMENT_METHOD: PaymentMethod = PaymentMethod.BANK_TRANSFER;
