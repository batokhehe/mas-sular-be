import { calculatePaymentServiceFee } from '../../src/modules/payments/gateway/domain/payment-service-fee';

describe('calculatePaymentServiceFee', () => {
  it.each([
    ['BNI_VA', 100_000, 4_000, 'FIXED', null],
    ['BRI_VA', 100_000, 4_000, 'FIXED', null],
    ['MANDIRI_BILL', 100_000, 4_000, 'FIXED', null],
    ['PERMATA_VA', 100_000, 4_000, 'FIXED', null],
    ['BCA_VA', 100_000, 0, 'NONE', null],
    ['SHOPEEPAY', 100_000, 0, 'NONE', null],
    ['CREDIT_CARD', 100_000, 0, 'NONE', null],
    ['GOPAY', 100_000, 2_000, 'PERCENTAGE', 0.02],
    ['QRIS', 100_000, 700, 'PERCENTAGE', 0.007],
  ])('%s charges the approved fee only', (paymentChannel, transactionBase, feeAmount, feeType, feeRate) => {
    expect(calculatePaymentServiceFee({ paymentChannel, transactionBase })).toEqual({ feeAmount, feeType, feeRate });
  });

  it.each([
    ['QRIS', 100_001, 700],
    ['GOPAY', 100_001, 2_000],
    ['QRIS', 100.5, 1],
  ])('uses standard nearest-Rupiah rounding for %s', (paymentChannel, transactionBase, feeAmount) => {
    expect(calculatePaymentServiceFee({ paymentChannel, transactionBase }).feeAmount).toBe(feeAmount);
  });

  it.each([
    ['QRIS', 0],
    ['GOPAY', -1],
    ['QRIS', Number.NaN],
    ['QRIS', Number.POSITIVE_INFINITY],
    ['UNKNOWN', 100_000],
    [undefined, 100_000],
  ])('returns zero for an invalid base or unsupported channel', (paymentChannel, transactionBase) => {
    expect(calculatePaymentServiceFee({ paymentChannel, transactionBase })).toEqual({
      feeAmount: 0,
      feeType: 'NONE',
      feeRate: null,
    });
  });

  it('supports large values without a fractional Rupiah', () => {
    expect(calculatePaymentServiceFee({ paymentChannel: 'QRIS', transactionBase: 9_999_999_999 }).feeAmount).toBe(70_000_000);
  });
});
