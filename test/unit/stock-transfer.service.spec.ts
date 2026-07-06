import { BadRequestException, ConflictException } from '@nestjs/common';
import { StockTransferService } from '../../src/modules/inventory/stock-transfer.service';

function buildPrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    stockTransfer: {
      create: jest.fn().mockResolvedValue({ id: 't1' }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }), // CAS-claim wins by default
    },
    stockTransferHistory: { create: jest.fn().mockResolvedValue({}) },
    // Source row is now locked via $queryRaw (SELECT ... FOR UPDATE).
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'pi-a', stock: 10, reserved: 0 }]),
    productInventory: {
      findUnique: jest.fn(), // destination lookup only
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  return {
    stockTransfer: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
    ...overrides,
  };
}

function svc(prisma: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new StockTransferService(prisma as any);
}

describe('StockTransferService', () => {
  it('requests a transfer with a REQUESTED history entry and an audit log', async () => {
    const prisma = buildPrisma();
    prisma.stockTransfer.findUnique = jest.fn().mockResolvedValue({ id: 't1', status: 'REQUESTED', history: [] });
    const service = svc(prisma);
    await service.requestTransfer({ productId: 'p1', fromOutletId: 'a', toOutletId: 'b', quantity: 5 }, 'admin-1');
    expect(prisma.__tx.stockTransferHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REQUESTED' }) }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('rejects a transfer where source and destination are the same', async () => {
    const service = svc(buildPrisma());
    await expect(
      service.requestTransfer({ productId: 'p1', fromOutletId: 'a', toOutletId: 'a', quantity: 5 }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('completes an approved transfer by moving stock between outlets (source locked, dest updated)', async () => {
    const prisma = buildPrisma();
    prisma.stockTransfer.findUnique = jest
      .fn()
      .mockResolvedValue({ id: 't1', status: 'APPROVED', productId: 'p1', fromOutletId: 'a', toOutletId: 'b', quantity: 5, history: [] });
    prisma.__tx.$queryRaw = jest.fn().mockResolvedValue([{ id: 'pi-a', stock: 10, reserved: 2 }]); // source, 8 available
    prisma.__tx.productInventory.findUnique = jest.fn().mockResolvedValue({ id: 'pi-b', stock: 0, reserved: 0 }); // destination

    const service = svc(prisma);
    await service.completeTransfer('t1', 'admin-1');

    // Source row was locked (FOR UPDATE) then decremented.
    expect(prisma.__tx.$queryRaw).toHaveBeenCalled();
    expect(prisma.__tx.productInventory.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pi-a' }, data: expect.objectContaining({ stock: { decrement: 5 } }) }),
    );
    // Destination updated correctly.
    expect(prisma.__tx.productInventory.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pi-b' }, data: expect.objectContaining({ stock: { increment: 5 } }) }),
    );
    // Audit unchanged.
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('refuses to complete when the source outlet lacks available stock', async () => {
    const prisma = buildPrisma();
    prisma.stockTransfer.findUnique = jest
      .fn()
      .mockResolvedValue({ id: 't1', status: 'APPROVED', productId: 'p1', fromOutletId: 'a', toOutletId: 'b', quantity: 5, history: [] });
    prisma.__tx.$queryRaw = jest.fn().mockResolvedValue([{ id: 'pi-a', stock: 3, reserved: 0 }]); // only 3 available
    const service = svc(prisma);
    await expect(service.completeTransfer('t1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  // --- H2 regression: concurrency-safe completion (source FOR UPDATE + status CAS). ---
  it('two concurrent completeTransfer(): only one succeeds; source decremented once', async () => {
    // In-memory store honouring the CAS (status flip) + a shared source row, so
    // exclusivity emerges from the query semantics, not a canned mock.
    const state = {
      transfer: { id: 't1', status: 'APPROVED', productId: 'p1', fromOutletId: 'a', toOutletId: 'b', quantity: 5, history: [] },
      source: { id: 'pi-a', stock: 6, reserved: 0 }, // enough for exactly ONE transfer of 5
      dest: { id: 'pi-b', stock: 0, reserved: 0 },
    };
    const db: any = {
      stockTransfer: {
        findUnique: jest.fn().mockImplementation(async () => ({ ...state.transfer })),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
          if (state.transfer.status === where.status) {
            state.transfer.status = data.status; // atomic within the mock body
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
      stockTransferHistory: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockImplementation(async () => [{ ...state.source }]),
      productInventory: {
        findUnique: jest.fn().mockImplementation(async () => ({ ...state.dest })),
        update: jest.fn().mockImplementation(async ({ where, data }: any) => {
          if (where.id === state.source.id && data.stock?.decrement) state.source.stock -= data.stock.decrement;
          if (where.id === state.dest.id && data.stock?.increment) state.dest.stock += data.stock.increment;
          return {};
        }),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    db.$transaction = jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(db));

    const service = svc(db);
    const results = await Promise.allSettled([
      service.completeTransfer('t1', 'admin-1'),
      service.completeTransfer('t1', 'admin-2'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    // Stock moved exactly once — never double-transferred / negative.
    expect(state.source.stock).toBe(1);
    expect(state.dest.stock).toBe(5);
  });
});
