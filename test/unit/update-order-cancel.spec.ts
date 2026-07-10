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

// ---------------- F2: restock fallback discriminator ----------------
// The legacy Product.stock increment must run ONLY for pre-reservation orders
// (no reservation rows AT ALL). Reservation-era orders whose reservations are
// already terminal (e.g. EXPIRED by the reservation worker before this
// cancellation) must NOT fall through — that double-restock inflated stock.
describe('OrderCancellationService restock fallback (F2)', () => {
  function buildCancelTx(reservationRowCount: number) {
    return {
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      inventoryReservation: { count: jest.fn().mockResolvedValue(reservationRowCount) },
      orderItem: { findMany: jest.fn().mockResolvedValue([{ productId: 'p1', quantity: 3 }]) },
      product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
  }

  it('reservation-era order with only TERMINAL reservations → release runs, NO legacy restock', async () => {
    const inventory = { releaseForOrder: jest.fn().mockResolvedValue({ handled: false }) }; // nothing active
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new OrderCancellationService(inventory as any);
    const tx = buildCancelTx(2); // rows exist (EXPIRED/RELEASED)

    const { cancelled } = await service.cancelAndRestock(tx as never, 'order-1', 'expiry after worker');

    expect(cancelled).toBe(true);
    expect(inventory.releaseForOrder).toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled(); // ← the F2 fix
    expect(tx.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('pre-reservation (legacy) order with ZERO reservation rows → legacy restock still runs', async () => {
    const inventory = { releaseForOrder: jest.fn().mockResolvedValue({ handled: false }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new OrderCancellationService(inventory as any);
    const tx = buildCancelTx(0);

    await service.cancelAndRestock(tx as never, 'order-1', 'legacy cancel');

    expect(tx.product.updateMany).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { stock: { increment: 3 } } });
  });

  it('active reservations → release handles stock; no fallback', async () => {
    const inventory = { releaseForOrder: jest.fn().mockResolvedValue({ handled: true }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new OrderCancellationService(inventory as any);
    const tx = buildCancelTx(2);

    await service.cancelAndRestock(tx as never, 'order-1', 'reject');

    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });
});
