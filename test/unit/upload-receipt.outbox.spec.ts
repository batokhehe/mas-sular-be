import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from '../../src/modules/payments/payments.service';

const PAYMENT = { id: 'pay-1', orderId: 'order-1', status: 'WAITING_VERIFICATION' };
const DTO = { receiptUrl: '/uploads/1700-abc.png', bankName: 'BCA', accountName: 'Jane' };
const USER = 'user-1';

type Opts = { owned?: boolean; flip?: number; fail?: 'outbox' };

function buildTx(opts: Opts) {
  const tx = {
    payment: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.flip ?? 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(PAYMENT),
    },
    outboxEvent: { create: jest.fn() },
  };
  tx.outboxEvent.create.mockImplementation(() =>
    opts.fail === 'outbox' ? Promise.reject(new Error('outbox insert failed')) : Promise.resolve({}),
  );
  return tx;
}

function build(opts: Opts = {}) {
  const tx = buildTx(opts);
  const prisma = {
    // ownership pre-check
    payment: { findFirst: jest.fn().mockResolvedValue(opts.owned === false ? null : { id: 'pay-1' }) },
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
  const uploadTokens = { consume: jest.fn(), resolveActive: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new PaymentsService(prisma as any, uploadTokens as any);
  return { service, prisma, tx };
}

describe('PaymentsService.uploadManualReceipt — ownership + state guard + atomicity', () => {
  it('owner upload: status-guarded CAS + outbox event in one transaction', async () => {
    const { service, prisma, tx } = build();

    const result = await service.uploadManualReceipt('pay-1', USER, DTO);

    // B1: ownership scoped to the caller (and soft-delete excluded)
    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { id: 'pay-1', deletedAt: null, order: { userId: USER } },
      select: { id: true },
    });
    // B2: only PENDING/WAITING_VERIFICATION can receive a receipt
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: { in: ['PENDING', 'WAITING_VERIFICATION'] } },
      data: expect.objectContaining({ status: 'WAITING_VERIFICATION', manualReceiptUrl: DTO.receiptUrl }),
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventName: 'payment.receipt_uploaded',
        payload: { paymentId: 'pay-1', orderId: 'order-1' },
        metadata: expect.objectContaining({ source: 'payments.uploadManualReceipt' }),
      }),
    });
    expect(result).toBe(PAYMENT);
  });

  it('B1: IDOR — a payment not owned by the caller is a 404 before any transaction', async () => {
    const { service, prisma, tx } = build({ owned: false });

    await expect(service.uploadManualReceipt('pay-1', 'attacker', DTO)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
  });

  it('B2: terminal payment cannot be reverted — CAS count 0 → 409, no event', async () => {
    const { service, tx } = build({ flip: 0 });

    await expect(service.uploadManualReceipt('pay-1', USER, DTO)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('emits the outbox event after the payment update', async () => {
    const { service, tx } = build();
    await service.uploadManualReceipt('pay-1', USER, DTO);
    expect(tx.payment.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.outboxEvent.create.mock.invocationCallOrder[0],
    );
  });

  it('rolls back (rejects) when the outbox insert fails', async () => {
    const { service, tx } = build({ fail: 'outbox' });
    await expect(service.uploadManualReceipt('pay-1', USER, DTO)).rejects.toThrow('outbox insert failed');
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });
});
