import { ExecutiveDashboardService } from '../../src/modules/admin/executive-dashboard.service';

// Extract the SQL text from either a Prisma.sql object (.strings) or a tagged
// template call (TemplateStringsArray), so the $queryRaw mock can route by query.
function sqlText(arg: unknown): string {
  if (arg && typeof arg === 'object' && Array.isArray((arg as { strings?: unknown }).strings)) {
    return (arg as { strings: string[] }).strings.join(' ');
  }
  if (Array.isArray(arg)) return (arg as string[]).join(' ');
  return String(arg ?? '');
}

const SALES_ROWS = [{ day: '2026-07-03', orders: 2, revenue: 100000 }];
const TOP_PRODUCTS = [{ productId: 'p1', name: 'Bakso Urat', qtySold: 20, revenue: 400000 }];

function buildPrisma() {
  return {
    order: {
      groupBy: jest.fn().mockImplementation((args: { by: string[] }) =>
        args.by[0] === 'userId'
          ? [{ userId: 'u1', _count: { _all: 5 }, _sum: { totalPrice: 300000 }, _max: { createdAt: new Date('2026-07-03T10:00:00Z') } }]
          : [
              { status: 'PROCESSING', _count: { _all: 3 } },
              { status: 'SHIPPED', _count: { _all: 2 } },
              { status: 'DELIVERED', _count: { _all: 5 } },
              { status: 'CANCELLED', _count: { _all: 1 } },
            ],
      ),
      aggregate: jest.fn().mockImplementation((args: { where: { createdAt: { lt?: Date } } }) =>
        args.where.createdAt.lt ? { _sum: { totalPrice: 250000 } } : { _sum: { totalPrice: 500000 } },
      ),
      count: jest.fn().mockImplementation((args: { where: { createdAt: { lt?: Date } } }) => (args.where.createdAt.lt ? 4 : 8)),
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'o1', orderNumber: 'BMS-1', totalPrice: 135123, paymentMethod: 'BANK_TRANSFER', status: 'PROCESSING',
          user: { name: 'Jane' }, payment: { status: 'WAITING_VERIFICATION' }, shipment: { status: 'RATE_SELECTED' },
        },
      ]),
    },
    payment: {
      groupBy: jest.fn().mockImplementation((args: { by: string[] }) =>
        args.by[0] === 'method'
          ? [
              { method: 'BANK_TRANSFER', _count: { _all: 8 } },
              { method: 'QRIS', _count: { _all: 3 } },
              { method: 'COD', _count: { _all: 2 } },
            ]
          : [
              { status: 'PENDING', _count: { _all: 4 } },
              { status: 'WAITING_VERIFICATION', _count: { _all: 2 } },
              { status: 'PAID', _count: { _all: 10 } },
            ],
      ),
    },
    product: {
      count: jest.fn().mockImplementation((args: { where: { stock: { gt?: number } } }) => (args.where.stock.gt !== undefined ? 3 : 1)),
      findMany: jest.fn().mockResolvedValue([{ id: 'p1', name: 'Bakso Urat', stock: 2 }]),
    },
    inventoryReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { reservedQty: 12 } }) },
    shipment: {
      groupBy: jest.fn().mockResolvedValue([
        { status: 'RATE_SELECTED', _count: { _all: 2 } },
        { status: 'IN_TRANSIT', _count: { _all: 1 } },
        { status: 'FAILED', _count: { _all: 1 } },
      ]),
      count: jest.fn().mockResolvedValue(4),
    },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', name: 'Jane', email: 'jane@x.com' }]) },
    outboxEvent: { groupBy: jest.fn().mockResolvedValue([{ status: 'PENDING', _count: { _all: 0 } }]) },
    notificationOutbox: { groupBy: jest.fn().mockResolvedValue([{ status: 'PENDING', _count: { _all: 0 } }]) },
    $queryRaw: jest.fn().mockImplementation((arg: unknown) => {
      const text = sqlText(arg);
      if (text.includes('OrderItem')) return Promise.resolve(TOP_PRODUCTS);
      if (text.includes('DATE(o.createdAt)')) return Promise.resolve(SALES_ROWS);
      return Promise.resolve([{ '1': 1 }]); // SELECT 1
    }),
  };
}

function svc(prisma = buildPrisma()) {
  // Dashboard key misses (→ compute); the redis health-check key reads back 'ok'.
  const cache = {
    get: jest.fn().mockImplementation(async (key: string) => (key === 'health-check' ? 'ok' : undefined)),
    set: jest.fn().mockResolvedValue(undefined),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service: new ExecutiveDashboardService(prisma as any, cache as any), prisma, cache };
}

describe('ExecutiveDashboardService.compute', () => {
  it('summary: revenue + orders compare to yesterday with direction', async () => {
    const { service } = svc();
    const d = await service.compute();
    expect(d.summary.todayRevenue).toMatchObject({ value: 500000, previous: 250000, changePct: 100, direction: 'up' });
    expect(d.summary.todayOrders).toMatchObject({ value: 8, previous: 4, changePct: 100, direction: 'up' });
  });

  it('summary: operational status counts come from the groupBy', async () => {
    const { service } = svc();
    const d = await service.compute();
    expect(d.summary).toMatchObject({
      pendingPayments: 4, // Payment PENDING
      pendingVerification: 2, // Payment WAITING_VERIFICATION
      processing: 3,
      shipped: 2,
      delivered: 5,
      cancelled: 1,
    });
  });

  it('paymentChart: method + status series include zero-filled enum members', async () => {
    const { service } = svc();
    const d = await service.compute();
    expect(d.paymentChart.byMethod).toEqual(
      expect.arrayContaining([
        { key: 'BANK_TRANSFER', count: 8 },
        { key: 'QRIS', count: 3 },
        { key: 'COD', count: 2 },
        { key: 'GATEWAY', count: 0 }, // present with 0 even though absent from the data
      ]),
    );
    expect(d.paymentChart.byStatus).toEqual(
      expect.arrayContaining([
        { key: 'PAID', count: 10 },
        { key: 'EXPIRED', count: 0 },
      ]),
    );
  });

  it('topProducts: qty, revenue, and derived average price', async () => {
    const { service } = svc();
    const d = await service.compute();
    expect(d.topProducts[0]).toEqual({ productId: 'p1', name: 'Bakso Urat', qtySold: 20, revenue: 400000, avgPrice: 20000 });
  });

  it('topCustomers: name resolved in one batch, revenue + last order mapped', async () => {
    const { service, prisma } = svc();
    const d = await service.compute();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1); // no N+1
    expect(d.topCustomers[0]).toMatchObject({ userId: 'u1', name: 'Jane', orders: 5, revenue: 300000 });
  });

  it('inventoryAlert: low / out / reserved / restock list', async () => {
    const { service } = svc();
    const d = await service.compute();
    expect(d.inventoryAlert).toMatchObject({ lowStock: 3, outOfStock: 1, reserved: 12 });
    expect(d.inventoryAlert.needRestock[0]).toEqual({ id: 'p1', name: 'Bakso Urat', stock: 2 });
  });

  it('shipmentSummary: buckets rolled up from the status groupBy + delivered-today', async () => {
    const { service } = svc();
    const d = await service.compute();
    expect(d.shipmentSummary).toEqual({ waiting: 2, inTransit: 1, deliveredToday: 4, failed: 1 });
  });

  it('systemHealth: all green when db/redis reachable and backlogs empty', async () => {
    const { service } = svc();
    const d = await service.compute();
    expect(d.systemHealth).toMatchObject({ database: 'green', redis: 'green', worker: 'green', notification: 'green' });
  });

  it('salesChart: daily series is contiguous (365 days, gap-filled) with the raw revenue point', async () => {
    const { service } = svc();
    const d = await service.compute();
    expect(d.salesChart.length).toBeGreaterThanOrEqual(365);
    const point = d.salesChart.find((p) => p.date === '2026-07-03');
    expect(point).toEqual({ date: '2026-07-03', revenue: 100000, orders: 2 });
    // A day with no orders is present with zeros (contiguous series).
    expect(d.salesChart.every((p) => typeof p.revenue === 'number' && typeof p.orders === 'number')).toBe(true);
  });
});

describe('ExecutiveDashboardService.getDashboard caching', () => {
  it('returns the cached payload without recomputing on a hit', async () => {
    const prisma = buildPrisma();
    const cache = { get: jest.fn().mockResolvedValue({ cached: true }), set: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new ExecutiveDashboardService(prisma as any, cache as any);
    const result = await service.getDashboard();
    expect(result).toEqual({ cached: true });
    expect(prisma.order.groupBy).not.toHaveBeenCalled(); // no compute on cache hit
  });

  it('computes then writes to cache (30s TTL) on a miss', async () => {
    const { service, cache } = svc();
    await service.getDashboard();
    expect(cache.set).toHaveBeenCalledWith('admin:executive-dashboard', expect.any(Object), 30_000);
  });
});
