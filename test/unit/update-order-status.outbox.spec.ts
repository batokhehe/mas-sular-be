import { NotFoundException } from '@nestjs/common';
import { AdminService } from '../../src/modules/admin/admin.service';
import { OrderCancellationService } from '../../src/modules/orders/order-cancellation.service';

type FailOp = 'order' | 'outbox' | undefined;

const EXISTING = { id: 'order-1', deletedAt: null };
const UPDATED = { id: 'order-1', status: 'DELIVERING', payment: {}, shipment: {} };

function buildTx(failOp: FailOp) {
  const tx = {
    order: { update: jest.fn() },
    outboxEvent: { create: jest.fn() },
  };
  tx.order.update.mockImplementation(() =>
    failOp === 'order' ? Promise.reject(new Error('order update failed')) : Promise.resolve(UPDATED),
  );
  tx.outboxEvent.create.mockImplementation(() =>
    failOp === 'outbox' ? Promise.reject(new Error('outbox insert failed')) : Promise.resolve({}),
  );
  return tx;
}

function build(failOp: FailOp = undefined, existing: unknown = EXISTING) {
  const tx = buildTx(failOp);
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(existing) }, // drives getOrder()
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AdminService(prisma as any, new OrderCancellationService());
  return { service, prisma, tx };
}

describe('AdminService.updateOrderStatus atomicity', () => {
  it('commits the status update and the outbox event in one transaction', async () => {
    const { service, prisma, tx } = build();

    const result = await service.updateOrderStatus('order-1', { status: 'DELIVERING', note: 'on the way' } as any);

    expect(prisma.order.findUnique).toHaveBeenCalledTimes(1); // getOrder validation
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1' },
        data: expect.objectContaining({
          status: 'DELIVERING',
          events: { create: { status: 'DELIVERING', note: 'on the way' } },
        }),
        include: { payment: true, shipment: true }, // include preserved
      }),
    );
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        aggregateType: 'order',
        aggregateId: 'order-1',
        eventName: 'order.status_updated',
        eventVersion: 1,
        exchange: 'orders',
        routingKey: 'order.status_updated',
        payload: { orderId: 'order-1', status: 'DELIVERING' },
      }),
    });
    expect(result).toBe(UPDATED);
  });

  it('emits the outbox event AFTER the order update', async () => {
    const { service, tx } = build();

    await service.updateOrderStatus('order-1', { status: 'DELIVERING' } as any);

    expect(tx.order.update.mock.invocationCallOrder[0]).toBeLessThan(
      tx.outboxEvent.create.mock.invocationCallOrder[0],
    );
  });

  it('uses the default note when none is supplied', async () => {
    const { service, tx } = build();

    await service.updateOrderStatus('order-1', { status: 'COMPLETED' } as any);

    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          events: { create: { status: 'COMPLETED', note: 'Order marked as COMPLETED' } },
        }),
      }),
    );
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

  it('rolls back (no event) when the order update fails', async () => {
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
