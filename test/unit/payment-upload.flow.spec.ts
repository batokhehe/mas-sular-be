import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from '../../src/modules/payments/payments.service';

// API consistency (8A.1): a missing/used/expired token is a uniform 404 on BOTH
// GET and POST (used vs invalid are indistinguishable → no enumeration). A valid
// token onto a no-longer-uploadable payment is a 409 (genuine state conflict).

const DTO = { receiptUrl: 'https://files/receipt.png', bankName: 'BCA', accountName: 'Jane' };
const PAYMENT = { id: 'pay-1', orderId: 'order-1', status: 'WAITING_VERIFICATION' };

// ---------- GET /payments/upload/:token ----------
function buildPage(opts: { token?: unknown; payment?: unknown } = {}) {
  const prisma = { payment: { findUnique: jest.fn().mockResolvedValue('payment' in opts ? opts.payment : pagePayment()) } };
  const uploadTokens = { resolveActive: jest.fn().mockResolvedValue('token' in opts ? opts.token : { paymentId: 'pay-1' }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new PaymentsService(prisma as any, uploadTokens as any);
  return { svc, prisma, uploadTokens };
}
function pagePayment(over: Record<string, unknown> = {}) {
  return { id: 'pay-1', status: 'PENDING', amount: 50000, method: 'BANK_TRANSFER', manualBankName: 'BCA', deletedAt: null, order: { orderNumber: 'BMS-1', totalPrice: 50000 }, ...over };
}

// ---------- POST /payments/upload/:token ----------
function buildSubmit(opts: { consumed?: boolean; flip?: number } = {}) {
  const tx = {
    payment: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.flip ?? 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(PAYMENT),
    },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)) };
  const consumed = opts.consumed ?? true;
  const uploadTokens = { consume: jest.fn().mockResolvedValue({ consumed, paymentId: consumed ? 'pay-1' : null }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new PaymentsService(prisma as any, uploadTokens as any);
  return { svc, tx, uploadTokens };
}

describe('Upload landing — getUploadPage', () => {
  it('returns page data for an active token + uploadable payment', async () => {
    const { svc } = buildPage();
    const page = await svc.getUploadPage('raw');
    expect(page).toEqual({ orderNumber: 'BMS-1', amount: 50000, businessTotal: 50000, uniqueCode: null, method: 'BANK_TRANSFER', bankName: 'BCA', status: 'PENDING' });
  });

  it('surfaces the manual BANK_TRANSFER unique code + business total so the upload page can display the breakdown', async () => {
    const { svc } = buildPage({ payment: pagePayment({ amount: 50123, uniqueCode: 123, order: { orderNumber: 'BMS-1', totalPrice: 50000 } }) });
    const page = await svc.getUploadPage('raw');
    expect(page.uniqueCode).toBe(123);
    expect(page.amount).toBe(50123); // exact transfer amount (business + code)
    expect(page.businessTotal).toBe(50000); // business total (Order.totalPrice)
  });

  it('404s (generic) on an invalid/expired/used token — no enumeration', async () => {
    const { svc, prisma } = buildPage({ token: null });
    await expect(svc.getUploadPage('raw')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
  });

  it.each(['PAID', 'FAILED', 'EXPIRED', 'REFUNDED'])('409s when the payment status is %s (blocked)', async (status) => {
    const { svc } = buildPage({ payment: pagePayment({ status }) });
    await expect(svc.getUploadPage('raw')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('Receipt submission — submitReceiptByToken', () => {
  it('upload success: consumes token, moves payment to WAITING_VERIFICATION, emits one event', async () => {
    const { svc, tx, uploadTokens } = buildSubmit();

    const result = await svc.submitReceiptByToken('raw', DTO);

    expect(uploadTokens.consume).toHaveBeenCalledTimes(1);
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: { in: ['PENDING', 'WAITING_VERIFICATION'] } },
      data: expect.objectContaining({ status: 'WAITING_VERIFICATION', manualReceiptUrl: DTO.receiptUrl }),
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventName: 'payment.receipt_uploaded',
        payload: { paymentId: 'pay-1', orderId: 'order-1' },
        metadata: expect.objectContaining({ source: 'payments.submitReceiptByToken' }),
      }),
    });
    expect(result).toBe(PAYMENT);
  });

  it('upload duplicate: a used/replayed token is a uniform 404 (matches GET) and emits no event', async () => {
    const { svc, tx } = buildSubmit({ consumed: false });
    await expect(svc.submitReceiptByToken('raw', DTO)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it.each(['PAID', 'FAILED', 'EXPIRED'])(
    'upload after %s: status guard fails (CAS count 0) → rejected, token+event rolled back',
    async (_status) => {
      const { svc, tx } = buildSubmit({ consumed: true, flip: 0 });
      await expect(svc.submitReceiptByToken('raw', DTO)).rejects.toBeInstanceOf(ConflictException);
      expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    },
  );
});
