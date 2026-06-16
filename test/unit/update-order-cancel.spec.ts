import { AdminService } from '../../src/modules/admin/admin.service';
import { OrderCancellationService } from '../../src/modules/orders/order-cancellation.service';

const ORDER = { id: 'order-1', deletedAt: null };
const CANCELLED_ORDER = { id: 'order-1', status: 'CANCELLED', payment: {}, shipment: {} };

type Opts = {
  orderCancel?: number;
  items?: Array<{ productId: string; quantity: number }>;
  fail?: 'restock' | 'outbox';
};

function buildTx(opts: Opts = {}) {
  const { orderCancel = 1, items = [{ productId: 'p1', quantity: 2 }], fail } = opts;
  const tx = {
    order: {
      updateMany: jest.fn().mockResolvedValue({ count: orderCancel }),
      findUnique: jest.fn().mockResolvedValue(CANCELLED_ORDER),
    },
    orderItem: { findMany: jest.fn().mockResolvedValue(items) },
    product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  if (fail === 'restock') tx.product.updateMany.mockRejectedValue(new Error('restock failed'));
  if (fail === 'outbox') tx.outboxEvent.create.mockRejectedValue(new Error('outbox insert failed'));
  return tx;
}

function build(opts: Opts = {}, existing: unknown = ORDER) {
  const tx = buildTx(opts);
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(existing) }, // drives getOrder()
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AdminService(prisma as any, new OrderCancellationService());
  return { service, prisma, tx };
}

describe('AdminService.updateOrderStatus(CANCELLED) — cancellation + restock', () => {
  it('first cancellation: CAS-cancels, restocks once, emits order.status_updated', async () => {
    const { service, tx } = build({
      items: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 5 },
      ],
    });

    const result = await service.updateOrderStatus('order-1', { status: 'CANCELLED', note: 'admin cancel' } as any);

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', deletedAt: null, status: { in: ['PENDING', 'PROCESSING', 'PACKING', 'SHIPPED', 'DELIVERING'] } },
      data: { status: 'CANCELLED' },
    });
    expect(tx.product.updateMany).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { stock: { increment: 2 } } });
    expect(tx.product.updateMany).toHaveBeenCalledWith({ where: { id: 'p2' }, data: { stock: { increment: 5 } } });
    expect(tx.orderEvent.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', status: 'CANCELLED', note: 'admin cancel' } });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventName: 'order.status_updated', payload: { orderId: 'order-1', status: 'CANCELLED' } }),
    });
    expect(result).toBe(CANCELLED_ORDER);
  });

  it('replay / non-active order: CAS count 0 → no restock, no event', async () => {
    const { service, tx } = build({ orderCancel: 0 });

    await service.updateOrderStatus('order-1', { status: 'CANCELLED' } as any);

    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(tx.orderEvent.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled(); // gated on the order CAS
  });

  it('aggregates duplicate product lines into one increment', async () => {
    const { service, tx } = build({ items: [{ productId: 'p1', quantity: 2 }, { productId: 'p1', quantity: 4 }] });
    await service.updateOrderStatus('order-1', { status: 'CANCELLED' } as any);
    expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.product.updateMany).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { stock: { increment: 6 } } });
  });

  it('rolls back (no event) when restock fails', async () => {
    const { service, tx } = build({ fail: 'restock' });
    await expect(service.updateOrderStatus('order-1', { status: 'CANCELLED' } as any)).rejects.toThrow('restock failed');
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('uses the default note when none supplied', async () => {
    const { service, tx } = build();
    await service.updateOrderStatus('order-1', { status: 'CANCELLED' } as any);
    expect(tx.orderEvent.create).toHaveBeenCalledWith({
      data: { orderId: 'order-1', status: 'CANCELLED', note: 'Order marked as CANCELLED' },
    });
  });
});
