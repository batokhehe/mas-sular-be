import { PaymentChannelCode } from './payment-channel';

export type PaymentServiceFeeType = 'NONE' | 'FIXED' | 'PERCENTAGE';

export interface PaymentServiceFee {
  feeAmount: number;
  feeType: PaymentServiceFeeType;
  /** Percentage expressed as a decimal (for example, 0.007 for 0.7%). */
  feeRate: number | null;
}

const BANK_TRANSFER_CHANNELS = new Set<PaymentChannelCode>([
  'BNI_VA',
  'BRI_VA',
  'MANDIRI_BILL',
  'PERMATA_VA',
]);

const FIXED_BANK_TRANSFER_FEE = 4_000;

/**
 * Calculates the customer-borne gateway fee from the backend-owned transaction
 * base. The caller persists the result on Order so future catalog changes cannot
 * alter an existing order's historical fee.
 */
export function calculatePaymentServiceFee(input: {
  paymentChannel?: string | null;
  transactionBase: number;
}): PaymentServiceFee {
  if (!Number.isFinite(input.transactionBase) || input.transactionBase <= 0) {
    return { feeAmount: 0, feeType: 'NONE', feeRate: null };
  }

  const channel = input.paymentChannel?.toUpperCase() as PaymentChannelCode | undefined;
  if (channel && BANK_TRANSFER_CHANNELS.has(channel)) {
    return { feeAmount: FIXED_BANK_TRANSFER_FEE, feeType: 'FIXED', feeRate: null };
  }
  if (channel === 'GOPAY') {
    return { feeAmount: Math.round(input.transactionBase * 0.02), feeType: 'PERCENTAGE', feeRate: 0.02 };
  }
  if (channel === 'QRIS') {
    return { feeAmount: Math.round(input.transactionBase * 0.007), feeType: 'PERCENTAGE', feeRate: 0.007 };
  }
  return { feeAmount: 0, feeType: 'NONE', feeRate: null };
}
