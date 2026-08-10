import { GatewayTransactionStatus, PaymentMethod } from '@prisma/client';
import { PaymentChannelCode, PaymentChannelDescriptor } from './payment-channel';
import { ChargeResult, PaymentInstructions } from './payment-provider.interface';

/**
 * NORMALIZED, customer-facing payment instruction.
 *
 * The storefront renders from this discriminated union alone — it never sees a
 * Midtrans response, a provider name, or a channel-specific quirk. Adding a
 * gateway changes this file at most; it never changes the frontend contract.
 */
export type PaymentInstructionView =
  | {
      type: 'MANUAL_TRANSFER';
      title: string;
      description: string;
      bank: string;
      accountName: string;
      accountNumber: string;
      amount: number;
      uniqueCode: number | null;
      steps: string[];
    }
  | { type: 'QR'; title: string; description: string; amount: number; qrString: string | null; qrImageUrl: string | null; steps: string[] }
  | { type: 'VA'; title: string; description: string; amount: number; bank: string; number: string; steps: string[] }
  | { type: 'DEEPLINK'; title: string; description: string; amount: number; buttonText: string; actionUrl: string | null; steps: string[] }
  | { type: 'REDIRECT'; title: string; description: string; amount: number; buttonText: string; actionUrl: string | null; steps: string[] };

/** Customer-facing bank label per VA channel. Never derived from a provider field. */
const VA_BANK_LABEL: Partial<Record<PaymentChannelCode, string>> = {
  BCA_VA: 'BCA',
  BNI_VA: 'BNI',
  BRI_VA: 'BRI',
  MANDIRI_BILL: 'Mandiri',
  PERMATA_VA: 'Permata',
};

/** Wallet button copy per e-wallet channel. */
const WALLET_BUTTON: Partial<Record<PaymentChannelCode, string>> = {
  GOPAY: 'Buka GoPay',
  SHOPEEPAY: 'Buka ShopeePay',
};

/**
 * Turn a provider's raw instructions into the normalized view. Pure — no I/O, no
 * provider knowledge beyond the channel code it was issued for.
 */
export function buildPaymentInstruction(
  channel: PaymentChannelCode,
  instructions: PaymentInstructions,
): PaymentInstructionView {
  const amount = instructions.amount;
  const steps = instructions.howTo ?? [];

  switch (instructions.kind) {
    case 'QR':
      return {
        type: 'QR',
        title: 'Scan QRIS',
        description: 'Scan menggunakan aplikasi e-wallet atau mobile banking.',
        amount,
        qrString: instructions.qrString ?? null,
        qrImageUrl: instructions.qrImageUrl ?? instructions.actionUrl ?? null,
        steps,
      };

    case 'VA': {
      const bank = VA_BANK_LABEL[channel] ?? 'Bank';
      return {
        type: 'VA',
        title: `${bank} Virtual Account`,
        description: `Transfer ke nomor Virtual Account ${bank} berikut sebelum batas waktu berakhir.`,
        amount,
        bank,
        number: instructions.vaNumber ?? '',
        steps,
      };
    }

    case 'DEEPLINK':
      return {
        type: 'DEEPLINK',
        title: 'Bayar dengan e-wallet',
        description: 'Lanjutkan ke aplikasi pembayaran untuk menyelesaikan transaksi.',
        amount,
        buttonText: WALLET_BUTTON[channel] ?? 'Buka Aplikasi',
        actionUrl: instructions.actionUrl ?? null,
        steps,
      };

    case 'REDIRECT':
      return {
        type: 'REDIRECT',
        title: 'Pembayaran Kartu',
        description: 'Anda akan diarahkan ke halaman verifikasi bank penerbit kartu.',
        amount,
        buttonText: 'Bayar Sekarang',
        actionUrl: instructions.actionUrl ?? null,
        steps,
      };

    case 'MANUAL_TRANSFER':
    default:
      return {
        type: 'MANUAL_TRANSFER',
        title: 'Transfer Bank',
        description: 'Transfer sesuai nominal berikut, lalu unggah bukti pembayaran.',
        amount,
        bank: instructions.bankName ?? '',
        accountName: instructions.accountName ?? '',
        accountNumber: instructions.accountNumber ?? '',
        uniqueCode: instructions.uniqueCode ?? null,
        steps,
      };
  }
}

/**
 * The additive block a checkout response carries for a gateway payment.
 * Every field is new; nothing existing is renamed or removed.
 */
export interface CheckoutGatewayPayload {
  paymentMethod: PaymentMethod;
  paymentChannel: PaymentChannelCode;
  /** Infrastructure detail, surfaced for admin/debugging — the UI never renders it. */
  provider: string;
  providerStatus: GatewayTransactionStatus;
  redirectUrl: string | null;
  deeplinkUrl: string | null;
  qrString: string | null;
  vaNumber: string | null;
  expiryAt: string | null;
  paymentInstruction: PaymentInstructionView;
}

/** Normalize a ChargeResult into the checkout/payment-detail response block. */
export function buildCheckoutGatewayPayload(
  result: ChargeResult,
  descriptor: PaymentChannelDescriptor,
): CheckoutGatewayPayload {
  const instruction = buildPaymentInstruction(result.channel, result.instructions);
  const isDeeplink = result.instructions.kind === 'DEEPLINK';

  return {
    paymentMethod: descriptor.method,
    paymentChannel: result.channel,
    provider: result.provider,
    providerStatus: result.providerStatus ?? GatewayTransactionStatus.PENDING,
    redirectUrl: isDeeplink ? null : result.instructions.actionUrl ?? null,
    deeplinkUrl: isDeeplink ? result.instructions.actionUrl ?? null : null,
    qrString: result.instructions.qrString ?? null,
    vaNumber: result.instructions.vaNumber ?? null,
    expiryAt: result.expiresAt ? result.expiresAt.toISOString() : null,
    paymentInstruction: instruction,
  };
}

/** The ledger columns needed to rebuild a payload without re-charging. */
export interface LedgerInstructionSource {
  channelCode: string;
  provider: string;
  status: GatewayTransactionStatus;
  grossAmount: number;
  vaNumber: string | null;
  qrString: string | null;
  redirectUrl: string | null;
  deeplinkUrl: string | null;
  expiryAt: Date | null;
}

/**
 * Rebuild the payload from a PERSISTED attempt (payment page reload) instead of
 * from a fresh ChargeResult. Read-only: it never contacts the provider, so a page
 * refresh can never create a second charge.
 */
export function buildGatewayPayloadFromLedger(
  row: LedgerInstructionSource,
  descriptor: PaymentChannelDescriptor,
): CheckoutGatewayPayload {
  const channel = row.channelCode as PaymentChannelCode;
  const actionUrl = row.deeplinkUrl ?? row.redirectUrl ?? undefined;
  const kind: PaymentInstructions['kind'] = row.deeplinkUrl
    ? 'DEEPLINK'
    : row.qrString
      ? 'QR'
      : row.vaNumber
        ? 'VA'
        : row.redirectUrl
          ? 'REDIRECT'
          : 'MANUAL_TRANSFER';

  const instructions: PaymentInstructions = {
    kind,
    amount: row.grossAmount,
    ...(row.vaNumber ? { vaNumber: row.vaNumber } : {}),
    ...(row.qrString ? { qrString: row.qrString } : {}),
    ...(actionUrl ? { actionUrl } : {}),
    howTo: [],
  };

  return {
    paymentMethod: descriptor.method,
    paymentChannel: channel,
    provider: row.provider,
    providerStatus: row.status,
    redirectUrl: row.redirectUrl,
    deeplinkUrl: row.deeplinkUrl,
    qrString: row.qrString,
    vaNumber: row.vaNumber,
    expiryAt: row.expiryAt ? row.expiryAt.toISOString() : null,
    paymentInstruction: buildPaymentInstruction(channel, instructions),
  };
}
