import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminService } from '../../src/modules/admin/admin.service';
import { OrderCancellationService } from '../../src/modules/orders/order-cancellation.service';

type FailOp = 'order' | 'outbox' | undefined;

const EXISTING = { id: 'order-1', deletedAt: null, status: 'PROCESSING' };
const UPDATED = { id: 'order-1', status: 'DELIVERING', payment: {}, shipment: {} };

function buildTx(failOp: FailOp) {
  const tx = {
    // Legal-transition CAS (F4) + explicit event row.
    order: {
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue(UPDATED),
    },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    outboxEvent: { create: jest.fn() },
  };
  tx.order.updateMany.mockImplementation(() =>
    failOp === 'order' ? Promise.reject(new Error('order update failed')) : Promise.resolve({ count: 1 }),
  );
  tx.outboxEvent.create.mockImplementation(() =>
    failOp === 'outbox' ? Promise.reject(new Error('outbox insert failed')) : Promise.resolve({}),
  );
  return tx;
}

function build(failOp: FailOp = undefined, existing: unknown = EXISTING) {
  const tx = buildTx(failOp);
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(existing) }, // drives getOrder() + no-op replay
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AdminService(prisma as any, new OrderCancellationService());
  return { service, prisma, tx };
}

describe('AdminService.updateOrderStatus atomicity + legal transitions', () => {
  it('commits the CAS status flip, the OrderEvent, and the outbox event in one transaction', async () => {
    const { service, prisma, tx } = build();

    const result = await service.updateOrderStatus('order-1', { status: 'DELIVERING', note: 'on the way' } as any);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const cas = tx.order.updateMany.mock.calls[0][0];
    expect(cas.data).toEqual({ status: 'DELIVERING' });
    expect(cas.where.id).toBe('order-1');
    expect(cas.where.status.in).toContain('PROCESSING'); // legal source
    expect(cas.where.status.in).not.toContain('CANCELLED'); // never out of a terminal state
    expect(tx.orderEvent.create).toHaveBeenCalledWith({
      data: { orderId: 'order-1', status: 'DELIVERING', note: 'on the way' },
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: 'order',
        aggregateId: 'order-1',
        eventName: 'order.status_updated',
        exchange: 'orders',
        routingKey: 'order.status_updated',
        payload: { orderId: 'order-1', status: 'DELIVERING' },
      }),
    });
    expect(result).toBe(UPDATED);
  });

  it('emits the outbox event AFTER the order flip', async () => {
    const { service, tx } = build();

    await service.updateOrderStatus('order-1', { status: 'DELIVERING' } as any);

    expect(tx.order.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.outboxEvent.create.mock.invocationCallOrder[0],
    );
  });

  it('uses the default note when none is supplied', async () => {
    const { service, tx } = build();

    await service.updateOrderStatus('order-1', { status: 'SHIPPED' } as any);

    expect(tx.orderEvent.create).toHaveBeenCalledWith({
      data: { orderId: 'order-1', status: 'SHIPPED', note: 'Order marked as SHIPPED' },
    });
  });

  it('F4: 409s on an illegal transition (CAS count 0) — no event, no outbox', async () => {
    const { service, tx } = build(undefined, { ...EXISTING, status: 'CANCELLED' });
    tx.order.updateMany.mockResolvedValue({ count: 0 }); // CANCELLED is not a legal source

    await expect(service.updateOrderStatus('order-1', { status: 'SHIPPED' } as any)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.orderEvent.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('F4: same-status update is an idempotent no-op (no transaction, no event)', async () => {
    const { service, prisma, tx } = build(undefined, { ...EXISTING, status: 'DELIVERING' });

    await service.updateOrderStatus('order-1', { status: 'DELIVERING' } as any);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('404s (no transaction) when the order is missing', async () => {
    const { service, prisma } = build(undefined, null);

    await expect(service.updateOrderStatus('order-x', { status: 'DELIVERING' } as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('404s for a soft-deleted order', async () => {
    const { service, prisma } = build(undefined, { ...EXISTING, deletedAt: new Date() });

    await expect(service.updateOrderStatus('order-1', { status: 'DELIVERING' } as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rolls back (no event) when the order flip fails', async () => {
    const { service, tx } = build('order');

    await expect(service.updateOrderStatus('order-1', { status: 'DELIVERING' } as any)).rejects.toThrow('order update failed');
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('rejects when the outbox insert fails so the status change is not half-applied', async () => {
    const { service, tx } = build('outbox');

    await expect(service.updateOrderStatus('order-1', { status: 'DELIVERING' } as any)).rejects.toThrow('outbox insert failed');
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });
});
