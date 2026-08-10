import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminService } from '../../src/modules/admin/admin.service';
import { PaymentSettlementService } from '../../src/modules/payments/settlement/payment-settlement.service';
import { OrderCancellationService } from '../../src/modules/orders/order-cancellation.service';

const PAYMENT = { id: 'pay-1', orderId: 'order-1', status: 'WAITING_VERIFICATION', deletedAt: null };
const REFRESHED = { id: 'pay-1', orderId: 'order-1', status: 'FAILED' };

type Opts = {
  paymentFlip?: number; // payment CAS rows affected
  orderCancel?: number; // order CAS rows affected
  items?: Array<{ productId: string; quantity: number }>;
  fail?: 'restock' | 'outbox';
};

function buildTx(opts: Opts = {}) {
  const { paymentFlip = 1, orderCancel = 1, items = [{ productId: 'p1', quantity: 2 }], fail } = opts;
  const tx = {
    payment: {
      updateMany: jest.fn().mockResolvedValue({ count: paymentFlip }),
      findUnique: jest.fn().mockResolvedValue(REFRESHED),
      // Phase 5E: the FAILED transition moved into PaymentSettlementService, which
      // re-reads the row after its CAS. Assertions below are unchanged.
      findUniqueOrThrow: jest.fn().mockResolvedValue(REFRESHED),
    },
    order: { updateMany: jest.fn().mockResolvedValue({ count: orderCancel }) },
    orderItem: { findMany: jest.fn().mockResolvedValue(items) },
    product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  if (fail === 'restock') tx.product.updateMany.mockRejectedValue(new Error('restock failed'));
  if (fail === 'outbox') tx.outboxEvent.create.mockRejectedValue(new Error('outbox insert failed'));
  return tx;
}

function build(opts: Opts = {}, payment: unknown = PAYMENT) {
  const tx = buildTx(opts);
  const prisma = {
    payment: { findUnique: jest.fn().mockResolvedValue(payment) },
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cancellation = new OrderCancellationService();
  const service = new AdminService(
    prisma as any, cancellation, undefined, undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new PaymentSettlementService(prisma as any, undefined, undefined, cancellation) as any,
  );
  return { service, prisma, tx };
}

describe('AdminService.rejectPayment — cancellation + restock', () => {
  it('first rejection: CAS-cancels, restocks once, emits payment.failed', async () => {
    const { service, tx } = build({
      items: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p1', quantity: 1 },
        { productId: 'p2', quantity: 3 },
      ],
    });

    const result = await service.rejectPayment('pay-1', { note: 'bad receipt' });

    // payment CAS (only flip from a non-terminal state)
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: { notIn: ['PAID', 'FAILED', 'EXPIRED', 'REFUNDED'] } },
      data: { status: 'FAILED' },
    });
    // order CAS over the active-status whitelist (NOT status != CANCELLED)
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', deletedAt: null, status: { in: ['PENDING', 'PROCESSING', 'PACKING', 'SHIPPED', 'DELIVERING'] } },
      data: { status: 'CANCELLED' },
    });
    // restock aggregated per product (p1: 2+1=3, p2: 3)
    expect(tx.product.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.product.updateMany).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { stock: { increment: 3 } } });
    expect(tx.product.updateMany).toHaveBeenCalledWith({ where: { id: 'p2' }, data: { stock: { increment: 3 } } });
    // cancellation event + domain event
    expect(tx.orderEvent.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', status: 'CANCELLED', note: 'bad receipt' } });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventName: 'payment.failed', payload: { paymentId: 'pay-1', orderId: 'order-1' } }),
    });
    expect(result).toBe(REFRESHED);
  });

  it('reject replay: already-FAILED returns the current payment with no side effects (200)', async () => {
    const current = { ...PAYMENT, status: 'FAILED' };
    const { service, prisma, tx } = build({}, current);

    const result = await service.rejectPayment('pay-1', {});

    expect(result).toBe(current); // returns the current payment
    expect(prisma.$transaction).not.toHaveBeenCalled(); // no work
    expect(tx.product.updateMany).not.toHaveBeenCalled(); // no restock
    expect(tx.orderEvent.create).not.toHaveBeenCalled(); // no audit/cancellation event
    expect(tx.outboxEvent.create).not.toHaveBeenCalled(); // no event
  });

  it.each(['PAID', 'EXPIRED', 'REFUNDED'])(
    'prevents rejecting a payment in terminal status %s (no transition to FAILED)',
    async (status) => {
      const { service, prisma, tx } = build({}, { ...PAYMENT, status });

      await expect(service.rejectPayment('pay-1', {})).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    },
  );

  it('order already cancelled by another path, payment not yet FAILED → payment.failed emitted, no restock', async () => {
    const { service, tx } = build({ paymentFlip: 1, orderCancel: 0 });

    await service.rejectPayment('pay-1', {});

    expect(tx.product.updateMany).not.toHaveBeenCalled(); // order CAS lost → no restock
    expect(tx.orderEvent.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1); // payment transition still emits
  });

  it('uses the default note when none is supplied', async () => {
    const { service, tx } = build();
    await service.rejectPayment('pay-1', {});
    expect(tx.orderEvent.create).toHaveBeenCalledWith({
      data: { orderId: 'order-1', status: 'CANCELLED', note: 'Payment rejected by admin' },
    });
  });

  it('rolls back (no event) when restock fails', async () => {
    const { service, tx } = build({ fail: 'restock' });
    await expect(service.rejectPayment('pay-1', {})).rejects.toThrow('restock failed');
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('rejects when the outbox insert fails so the rejection is not half-applied', async () => {
    const { service, tx } = build({ fail: 'outbox' });
    await expect(service.rejectPayment('pay-1', {})).rejects.toThrow('outbox insert failed');
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('404s before opening a transaction when the payment is missing', async () => {
    const { service, prisma } = build({}, null);
    await expect(service.rejectPayment('pay-x', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('404s for a soft-deleted payment', async () => {
    const { service, prisma } = build({}, { ...PAYMENT, deletedAt: new Date() });
    await expect(service.rejectPayment('pay-1', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
