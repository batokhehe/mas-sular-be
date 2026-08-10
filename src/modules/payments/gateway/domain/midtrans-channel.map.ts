import { PaymentChannelCode } from './payment-channel';
import { PaymentInstructions } from './payment-provider.interface';

/**
 * THE single place internal channel codes meet Midtrans wire format.
 *
 * Nothing else in the codebase may know that `BCA_VA` means
 * `payment_type: bank_transfer, bank: bca`. Adding a Midtrans channel is one
 * entry here plus a catalog row — no provider, service, or controller changes.
 */

/** Context the payload builders may need; all optional and channel-specific. */
export interface MidtransPayloadContext {
  /** Card token minted by the browser SDK (CREDIT_CARD only, Phase 5). */
  cardTokenId?: string;
  /** Where the e-wallet should send the customer back (GOPAY / SHOPEEPAY). */
  callbackUrl?: string;
  /** Shown on the Mandiri bill payment screen. */
  billInfo?: { info1: string; info2: string };
}

export interface MidtransChannelSpec {
  /** Midtrans `payment_type`. */
  paymentType: string;
  /** Bank code for `bank_transfer` channels. */
  bank?: string;
  /** True when the charge cannot be built without a browser-side card token. */
  requiresCardToken?: boolean;
  /** The payment_type-specific object merged into the charge body. */
  buildPayload(ctx: MidtransPayloadContext): Record<string, unknown> | undefined;
  /** How the customer completes this channel — drives the storefront UI. */
  instructionKind: PaymentInstructions['kind'];
}

const bankTransfer = (bank: string): MidtransChannelSpec => ({
  paymentType: 'bank_transfer',
  bank,
  instructionKind: 'VA',
  buildPayload: () => ({ bank_transfer: { bank } }),
});

/**
 * Channel → Midtrans. MANUAL_TRANSFER is intentionally absent: it is served by
 * ManualTransferProvider and never reaches Midtrans.
 */
export const MIDTRANS_CHANNEL_MAP: Partial<Record<PaymentChannelCode, MidtransChannelSpec>> = {
  QRIS: {
    paymentType: 'qris',
    instructionKind: 'QR',
    // acquirer omitted → Midtrans picks the merchant's configured QRIS acquirer.
    buildPayload: () => ({ qris: {} }),
  },
  GOPAY: {
    paymentType: 'gopay',
    instructionKind: 'DEEPLINK',
    buildPayload: (ctx) => ({
      gopay: {
        enable_callback: Boolean(ctx.callbackUrl),
        ...(ctx.callbackUrl ? { callback_url: ctx.callbackUrl } : {}),
      },
    }),
  },
  SHOPEEPAY: {
    paymentType: 'shopeepay',
    instructionKind: 'DEEPLINK',
    buildPayload: (ctx) => ({ shopeepay: ctx.callbackUrl ? { callback_url: ctx.callbackUrl } : {} }),
  },
  BCA_VA: bankTransfer('bca'),
  BNI_VA: bankTransfer('bni'),
  BRI_VA: bankTransfer('bri'),
  PERMATA_VA: bankTransfer('permata'),
  MANDIRI_BILL: {
    // Mandiri is Midtrans "echannel" (bill payment), NOT bank_transfer — it
    // returns bill_key + biller_code instead of a VA number.
    paymentType: 'echannel',
    instructionKind: 'VA',
    buildPayload: (ctx) => ({
      echannel: {
        bill_info1: ctx.billInfo?.info1 ?? 'Payment',
        bill_info2: ctx.billInfo?.info2 ?? 'Order',
      },
    }),
  },
  CREDIT_CARD: {
    paymentType: 'credit_card',
    instructionKind: 'REDIRECT',
    requiresCardToken: true,
    buildPayload: (ctx) => ({
      credit_card: { token_id: ctx.cardTokenId, authentication: true }, // 3DS always on
    }),
  },
};

export function midtransSpecFor(channel: PaymentChannelCode): MidtransChannelSpec | undefined {
  return MIDTRANS_CHANNEL_MAP[channel];
}

export function midtransSupportedChannels(): PaymentChannelCode[] {
  return Object.keys(MIDTRANS_CHANNEL_MAP) as PaymentChannelCode[];
}

// ---------------------------------------------------------------- responses --

/** The subset of a Midtrans charge/status response this integration reads. */
export interface MidtransChargeResponse {
  status_code?: string;
  status_message?: string;
  transaction_id?: string;
  order_id?: string;
  transaction_status?: string;
  fraud_status?: string;
  payment_type?: string;
  gross_amount?: string;
  expiry_time?: string;
  transaction_time?: string;
  redirect_url?: string;
  permata_va_number?: string;
  bill_key?: string;
  biller_code?: string;
  qr_string?: string;
  va_numbers?: Array<{ bank?: string; va_number?: string }>;
  actions?: Array<{ name?: string; method?: string; url?: string }>;
}

function action(response: MidtransChargeResponse, name: string): string | undefined {
  return response.actions?.find((a) => a.name === name)?.url;
}

/**
 * Pull the channel-specific payment handle out of a Midtrans response. Kept here
 * so the provider never branches on payment_type.
 */
export function extractChannelArtifacts(
  channel: PaymentChannelCode,
  response: MidtransChargeResponse,
): { vaNumber?: string; qrString?: string; deeplinkUrl?: string; redirectUrl?: string } {
  const spec = midtransSpecFor(channel);
  if (!spec) return {};

  switch (channel) {
    case 'QRIS':
      return {
        // Newer Core API returns the QR as an action URL; older responses inline it.
        qrString: response.qr_string,
        redirectUrl: action(response, 'generate-qr-code'),
      };
    case 'GOPAY':
      return {
        deeplinkUrl: action(response, 'deeplink-redirect'),
        redirectUrl: action(response, 'generate-qr-code'),
      };
    case 'SHOPEEPAY':
      return { deeplinkUrl: action(response, 'deeplink-redirect') };
    case 'PERMATA_VA':
      return { vaNumber: response.permata_va_number ?? vaFor(response, 'permata') };
    case 'MANDIRI_BILL':
      // Composite handle: the customer keys biller code + bill key at the ATM.
      return { vaNumber: response.bill_key ? `${response.biller_code ?? ''}:${response.bill_key}` : undefined };
    case 'BCA_VA':
    case 'BNI_VA':
    case 'BRI_VA':
      return { vaNumber: vaFor(response, spec.bank!) };
    case 'CREDIT_CARD':
      return { redirectUrl: response.redirect_url };
    default:
      return {};
  }
}

function vaFor(response: MidtransChargeResponse, bank: string): string | undefined {
  return response.va_numbers?.find((v) => v.bank?.toLowerCase() === bank)?.va_number ?? response.va_numbers?.[0]?.va_number;
}

/** Customer-facing steps per channel. Indonesian copy; never names the gateway. */
export function buildHowTo(channel: PaymentChannelCode, artifacts: ReturnType<typeof extractChannelArtifacts>): string[] {
  switch (channel) {
    case 'QRIS':
      return ['Buka aplikasi bank atau e-wallet Anda.', 'Pindai kode QR yang ditampilkan.', 'Selesaikan pembayaran sebelum batas waktu berakhir.'];
    case 'GOPAY':
    case 'SHOPEEPAY':
      return ['Lanjutkan ke aplikasi pembayaran melalui tombol yang tersedia.', 'Konfirmasi pembayaran di aplikasi.', 'Kembali ke halaman ini setelah pembayaran selesai.'];
    case 'MANDIRI_BILL':
      return ['Buka ATM/aplikasi Mandiri lalu pilih Bayar > Multipayment.', `Masukkan kode dan nomor tagihan: ${artifacts.vaNumber ?? '-'}.`, 'Selesaikan pembayaran sebelum batas waktu berakhir.'];
    case 'CREDIT_CARD':
      return ['Anda akan diarahkan ke halaman verifikasi 3D Secure.', 'Selesaikan verifikasi dari bank penerbit kartu Anda.'];
    default:
      return ['Buka aplikasi bank Anda lalu pilih Transfer ke Virtual Account.', `Masukkan nomor Virtual Account: ${artifacts.vaNumber ?? '-'}.`, 'Selesaikan pembayaran sebelum batas waktu berakhir.'];
  }
}
