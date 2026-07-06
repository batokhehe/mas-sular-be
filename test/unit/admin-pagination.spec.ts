import { AdminService } from '../../src/modules/admin/admin.service';
import { InventoryReservationService } from '../../src/modules/inventory/inventory-reservation.service';
import { StockTransferService } from '../../src/modules/inventory/stock-transfer.service';
import { pageArgs, paginate } from '../../src/common/pagination/pagination';

// A prisma model mock whose findMany echoes the args it was called with (so we
// can assert skip/take/where/orderBy) and whose count returns a fixed total.
function model(total: number) {
  return {
    findMany: jest.fn().mockImplementation(async (args: unknown) => [{ __args: args }]),
    count: jest.fn().mockResolvedValue(total),
  };
}

describe('pagination helper (M3/M4)', () => {
  it('defaults to page 1, limit 20 (skip 0, take 20)', () => {
    expect(pageArgs({})).toEqual({ skip: 0, take: 20, page: 1, limit: 20 });
  });

  it('honours a custom page + limit', () => {
    expect(pageArgs({ page: 3, limit: 15 })).toEqual({ skip: 30, take: 15, page: 3, limit: 15 });
  });

  it('clamps limit to a maximum of 100', () => {
    expect(pageArgs({ limit: 1000 }).take).toBe(100);
    expect(pageArgs({ limit: 1000 }).limit).toBe(100);
  });

  it('floors page/limit to their minimum of 1', () => {
    expect(pageArgs({ page: 0, limit: 0 })).toEqual({ skip: 0, take: 20, page: 1, limit: 20 });
    expect(pageArgs({ page: -5, limit: -5 }).page).toBe(1);
  });

  it('computes totalPages via ceil and preserves the envelope', () => {
    expect(paginate([1, 2], 45, 2, 20)).toEqual({ items: [1, 2], page: 2, limit: 20, total: 45, totalPages: 3 });
    expect(paginate([], 0, 1, 20).totalPages).toBe(0);
  });
});

describe('AdminService.listOrders pagination', () => {
  function svc(total = 57) {
    const order = model(total);
    const prisma = { order } as unknown;
    // AdminService only needs prisma for listOrders; cancellation is unused here.
    const service = new AdminService(prisma as never, {} as never);
    return { service, order };
  }

  it('applies default pagination (skip 0, take 20) and returns the envelope with total', async () => {
    const { service, order } = svc(57);
    const res = await service.listOrders({});
    expect(order.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20 }));
    expect(res).toEqual(expect.objectContaining({ page: 1, limit: 20, total: 57, totalPages: 3 }));
    expect(res.items).toHaveLength(1);
  });

  it('honours a custom limit and enforces the max of 100', async () => {
    const { service, order } = svc(500);
    await service.listOrders({ limit: 5 });
    expect(order.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5 }));
    await service.listOrders({ limit: 1000 });
    expect(order.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 100 }));
  });

  it('preserves filtering (status + paymentStatus) and applies the same where to count', async () => {
    const { service, order } = svc(3);
    await service.listOrders({ status: 'PENDING' as never, paymentStatus: 'PAID' as never, page: 2, limit: 10 });
    const findWhere = order.findMany.mock.calls[0][0].where;
    expect(findWhere).toMatchObject({ deletedAt: null, status: 'PENDING', payment: { status: 'PAID' } });
    expect(order.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
    // count() is filtered by the identical where clause.
    expect(order.count).toHaveBeenCalledWith({ where: findWhere });
  });

  it('preserves sorting (createdAt desc)', async () => {
    const { service, order } = svc();
    await service.listOrders({});
    expect(order.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'desc' } }));
  });
});

describe('AdminService.listShipments pagination', () => {
  it('paginates and preserves the status filter + sorting', async () => {
    const shipment = model(12);
    const service = new AdminService({ shipment } as never, {} as never);
    const res = await service.listShipments({ status: 'IN_TRANSIT' as never, page: 2, limit: 5 });
    expect(shipment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'IN_TRANSIT' }, skip: 5, take: 5, orderBy: { createdAt: 'desc' } }),
    );
    expect(shipment.count).toHaveBeenCalledWith({ where: { status: 'IN_TRANSIT' } });
    expect(res).toEqual(expect.objectContaining({ page: 2, limit: 5, total: 12, totalPages: 3 }));
  });
});

describe('StockTransferService list pagination', () => {
  it('listInventory paginates and preserves the search filter + sorting', async () => {
    const productInventory = model(80);
    const service = new StockTransferService({ productInventory } as never);
    const res = await service.listInventory({ search: 'ayam', page: 3, limit: 25 });
    const args = productInventory.findMany.mock.calls[0][0];
    expect(args).toMatchObject({ skip: 50, take: 25, orderBy: [{ outletId: 'asc' }, { productId: 'asc' }] });
    expect(args.where.OR).toBeDefined();
    expect(productInventory.count).toHaveBeenCalledWith({ where: args.where });
    expect(res).toEqual(expect.objectContaining({ page: 3, limit: 25, total: 80, totalPages: 4 }));
  });

  it('listTransfers paginates, preserves the status filter, and defaults with no args', async () => {
    const stockTransfer = model(40);
    const service = new StockTransferService({ stockTransfer } as never);
    await service.listTransfers({ status: 'APPROVED' as never });
    expect(stockTransfer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'APPROVED' }, skip: 0, take: 20, orderBy: { createdAt: 'desc' } }),
    );
    // Callable with no args → defaults.
    await service.listTransfers();
    expect(stockTransfer.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 0, take: 20 }));
  });
});

describe('InventoryReservationService.listReservations pagination', () => {
  it('paginates, preserves search + sorting, and counts the same where', async () => {
    const inventoryReservation = model(33);
    const service = new InventoryReservationService({ inventoryReservation } as never);
    const res = await service.listReservations({ search: 'ORD-1', page: 2, limit: 20 });
    const args = inventoryReservation.findMany.mock.calls[0][0];
    expect(args).toMatchObject({ skip: 20, take: 20, orderBy: { createdAt: 'desc' } });
    expect(args.where.OR).toBeDefined();
    expect(inventoryReservation.count).toHaveBeenCalledWith({ where: args.where });
    expect(res).toEqual(expect.objectContaining({ page: 2, limit: 20, total: 33, totalPages: 2 }));
  });
});
