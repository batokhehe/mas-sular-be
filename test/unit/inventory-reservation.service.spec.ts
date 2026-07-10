import { BadRequestException } from '@nestjs/common';
import { PaymentMethod, ReservationStatus } from '@prisma/client';
import { InventoryReservationService } from '../../src/modules/inventory/inventory-reservation.service';

function buildTx(overrides: Record<string, unknown> = {}) {
  return {
    outlet: { findFirst: jest.fn().mockResolvedValue({ id: 'outlet-1' }) },
    $queryRaw: jest.fn().mockResolvedValue([{ stock: 10 }]),
    inventoryReservation: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { reservedQty: 0 } }),
      create: jest.fn().mockResolvedValue({ id: 'res-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ reservedQty: 2 }),
    },
    inventoryReservationHistory: { create: jest.fn().mockResolvedValue({}) },
    product: { update: jest.fn().mockResolvedValue({}) },
    productInventory: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
}

function buildPrisma(tx = buildTx()) {
  return {
    product: { findUnique: jest.fn().mockResolvedValue({ stock: 10 }) },
    inventoryReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { reservedQty: 3 } }) },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
}

function svc(prisma = buildPrisma()) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service: new InventoryReservationService(prisma as any), prisma };
}

const items = [{ productId: 'p1', quantity: 2 }];

describe('InventoryReservationService', () => {
  it('reserves stock when available (creates reservation + history, locks the row)', async () => {
    const tx = buildTx();
    const { service } = svc();
    await service.reserveForOrder(tx as never, { orderId: 'o1', items, paymentMethod: PaymentMethod.BANK_TRANSFER });

    expect(tx.$queryRaw).toHaveBeenCalled(); // FOR UPDATE lock
    expect(tx.inventoryReservation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderId: 'o1', productId: 'p1', reservedQty: 2, status: ReservationStatus.RESERVED }) }),
    );
    expect(tx.inventoryReservationHistory.create).toHaveBeenCalled();
  });

  it('prevents overselling: throws when available < requested', async () => {
    // stock 10, already reserved 9 → available 1 < 2 requested.
    const tx = buildTx({
      $queryRaw: jest.fn().mockResolvedValue([{ stock: 10 }]),
      inventoryReservation: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { reservedQty: 9 } }),
        create: jest.fn(),
      },
      inventoryReservationHistory: { create: jest.fn() },
    });
    const { service } = svc();
    await expect(
      service.reserveForOrder(tx as never, { orderId: 'o1', items, paymentMethod: PaymentMethod.QRIS }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.inventoryReservation.create).not.toHaveBeenCalled();
  });

  it('serializes concurrent checkouts: second reservation sees the first and is rejected', async () => {
    // Same product row (stock 3). First reserve sees 0 reserved → ok. Second sees 2 → available 1 < 2 → reject.
    const aggregate = jest
      .fn()
      .mockResolvedValueOnce({ _sum: { reservedQty: 0 } })
      .mockResolvedValueOnce({ _sum: { reservedQty: 2 } });
    const tx = buildTx({
      $queryRaw: jest.fn().mockResolvedValue([{ stock: 3 }]),
      inventoryReservation: { aggregate, create: jest.fn().mockResolvedValue({ id: 'r' }) },
    });
    const { service } = svc();
    await service.reserveForOrder(tx as never, { orderId: 'oA', items, paymentMethod: PaymentMethod.QRIS });
    await expect(
      service.reserveForOrder(tx as never, { orderId: 'oB', items, paymentMethod: PaymentMethod.QRIS }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('commits reservations: CAS-transitions RESERVED → COMMITTED, deducts Product.stock', async () => {
    const tx = buildTx({
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'res-1', productId: 'p1', reservedQty: 2, outletId: null }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryReservationHistory: { create: jest.fn() },
      product: { update: jest.fn().mockResolvedValue({}) },
    });
    const { service } = svc();
    const n = await service.commitForOrder(tx as never, 'o1');
    expect(n).toBe(1);
    expect(tx.inventoryReservation.updateMany).toHaveBeenCalledWith({
      where: { id: 'res-1', status: ReservationStatus.RESERVED }, // C2: fenced transition
      data: { status: ReservationStatus.COMMITTED, committedQty: 2 },
    });
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { stock: { decrement: 2 } } });
  });

  // --- Regression: C2 — a reservation expired between snapshot and commit is skipped. ---
  it('commit skips a reservation that lost the CAS (expired concurrently): no deduction, not counted', async () => {
    const tx = buildTx({
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'res-1', productId: 'p1', reservedQty: 2, outletId: null }]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }), // expiry worker won
      },
      inventoryReservationHistory: { create: jest.fn() },
      product: { update: jest.fn() },
    });
    const { service } = svc();
    const n = await service.commitForOrder(tx as never, 'o1');
    expect(n).toBe(0);
    expect(tx.product.update).not.toHaveBeenCalled(); // stock never touched
    expect(tx.inventoryReservationHistory.create).not.toHaveBeenCalled();
  });

  it('releases committed reservations (restocks) and reports handled=true', async () => {
    const tx = buildTx({
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'res-1', productId: 'p1', outletId: null, reservedQty: 2, committedQty: 2, status: ReservationStatus.COMMITTED }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryReservationHistory: { create: jest.fn() },
      product: { update: jest.fn().mockResolvedValue({}) },
    });
    const { service } = svc();
    const result = await service.releaseForOrder(tx as never, 'o1', ReservationStatus.RELEASED);
    expect(result.handled).toBe(true);
    expect(tx.inventoryReservation.updateMany).toHaveBeenCalledWith({
      where: { id: 'res-1', status: ReservationStatus.COMMITTED }, // CAS on the observed status
      data: { status: ReservationStatus.RELEASED, releasedQty: 2 },
    });
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { stock: { increment: 2 } } });
  });

  it('release skips a reservation whose state changed after the snapshot (no double counter move)', async () => {
    const tx = buildTx({
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'res-1', productId: 'p1', outletId: null, reservedQty: 2, committedQty: 0, status: ReservationStatus.RESERVED }]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }), // expired concurrently
      },
      inventoryReservationHistory: { create: jest.fn() },
      product: { update: jest.fn() },
    });
    const { service } = svc();
    await service.releaseForOrder(tx as never, 'o1', ReservationStatus.RELEASED);
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.inventoryReservationHistory.create).not.toHaveBeenCalled();
  });

  it('release reports handled=false when there are no reservations (legacy order)', async () => {
    const tx = buildTx({ inventoryReservation: { findMany: jest.fn().mockResolvedValue([]) } });
    const { service } = svc();
    const result = await service.releaseForOrder(tx as never, 'o1');
    expect(result.handled).toBe(false);
  });

  it('expireReservation CAS-transitions RESERVED → EXPIRED', async () => {
    const prisma = buildPrisma();
    const { service } = svc(prisma);
    const ok = await service.expireReservation('res-1');
    expect(ok).toBe(true);
    expect(prisma.__tx.inventoryReservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'res-1', status: ReservationStatus.RESERVED }, data: expect.objectContaining({ status: ReservationStatus.EXPIRED }) }),
    );
  });

  // --- Regression: C1 — expiry must free the per-outlet ProductInventory hold. ---
  it('expireReservation releases the per-outlet ProductInventory hold (reserved decremented, available recovered)', async () => {
    const tx = buildTx({
      inventoryReservation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ reservedQty: 3, productId: 'p1', outletId: 'outlet-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      productInventory: {
        findUnique: jest.fn().mockResolvedValue({ id: 'pi-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      // C5: the row is re-read FOR UPDATE; available is computed from the locked values.
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'pi-1', stock: 10, reserved: 3 }]),
      inventoryReservationHistory: { create: jest.fn() },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = { $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)), __tx: tx };
    const service = new InventoryReservationService(prisma);

    const ok = await service.expireReservation('res-1');

    expect(ok).toBe(true);
    // stock 10, reserved 3 − 3 → available back to 10; stock untouched.
    expect(tx.productInventory.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pi-1' }, data: expect.objectContaining({ reserved: { decrement: 3 }, available: 10 }) }),
    );
    expect(tx.inventoryReservation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'res-1' }, data: { releasedQty: 3 } }),
    );
  });

  it('expireReservation leaves ProductInventory untouched for legacy reservations (no outlet)', async () => {
    const tx = buildTx({
      inventoryReservation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ reservedQty: 2, productId: 'p1', outletId: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      inventoryReservationHistory: { create: jest.fn() },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = { $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)), __tx: tx };
    const service = new InventoryReservationService(prisma);

    await service.expireReservation('res-1');

    expect(tx.productInventory.findUnique).not.toHaveBeenCalled();
    expect(tx.productInventory.update).not.toHaveBeenCalled();
  });

  it('expireReservation is a no-op when the CAS loses the race (already expired)', async () => {
    const tx = buildTx({
      inventoryReservation: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      productInventory: { findUnique: jest.fn(), update: jest.fn() },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = { $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)), __tx: tx };
    const service = new InventoryReservationService(prisma);

    const ok = await service.expireReservation('res-1');
    expect(ok).toBe(false);
    expect(tx.productInventory.update).not.toHaveBeenCalled();
  });

  it('computes available stock = Product.stock − active reserved', async () => {
    const { service } = svc(); // product stock 10, reserved 3
    expect(await service.availableFor('p1')).toBe(7);
  });

  it('reserves against ProductInventory when an outlet is allocated (multi-outlet)', async () => {
    const tx = buildTx({
      productInventory: {
        findUnique: jest.fn().mockResolvedValue({ id: 'pi-1', stock: 10, reserved: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ stock: 10, reserved: 0 }]),
      inventoryReservation: { create: jest.fn().mockResolvedValue({ id: 'res-9' }) },
      inventoryReservationHistory: { create: jest.fn() },
    });
    const { service } = svc();
    await service.reserveForOrder(tx as never, {
      orderId: 'o1', items, paymentMethod: PaymentMethod.QRIS, outletId: 'outlet-1',
    });
    // Reserves against the per-outlet ProductInventory row (not Product.stock).
    expect(tx.productInventory.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pi-1' }, data: expect.objectContaining({ reserved: { increment: 2 } }) }),
    );
    expect(tx.inventoryReservation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outletId: 'outlet-1' }) }),
    );
  });

  // --- H1 regression: deterministic FOR UPDATE lock ordering (deadlock prevention). ---
  describe('H1 — deterministic lock ordering', () => {
    // Legacy path locks `Product` rows via $queryRaw; capture the productId of each
    // FOR UPDATE in call order (Prisma.sql exposes interpolated values).
    function capturingTx() {
      const lockOrder: string[] = [];
      const tx = buildTx({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        $queryRaw: jest.fn().mockImplementation(async (sql: any) => {
          lockOrder.push(sql.values[0] as string);
          return [{ stock: 100 }];
        }),
        inventoryReservation: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { reservedQty: 0 } }),
          create: jest.fn().mockResolvedValue({ id: 'res-x' }),
        },
        inventoryReservationHistory: { create: jest.fn() },
      });
      return { tx, lockOrder };
    }

    it('locks in identical ascending-productId order for [p1,p2] and reversed [p2,p1]', async () => {
      const { service } = svc();

      const a = capturingTx();
      await service.reserveForOrder(a.tx as never, {
        orderId: 'oA',
        items: [{ productId: 'p2', quantity: 1 }, { productId: 'p1', quantity: 1 }],
        paymentMethod: PaymentMethod.QRIS,
      });

      const b = capturingTx();
      await service.reserveForOrder(b.tx as never, {
        orderId: 'oB',
        items: [{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }],
        paymentMethod: PaymentMethod.QRIS,
      });

      expect(a.lockOrder).toEqual(['p1', 'p2']);
      expect(b.lockOrder).toEqual(['p1', 'p2']);
      expect(a.lockOrder).toEqual(b.lockOrder); // identical regardless of cart order
    });

    it('reservation result is unchanged (every item reserved with correct qty)', async () => {
      const { tx } = capturingTx();
      const { service } = svc();
      await service.reserveForOrder(tx as never, {
        orderId: 'o1',
        items: [{ productId: 'p2', quantity: 3 }, { productId: 'p1', quantity: 2 }],
        paymentMethod: PaymentMethod.QRIS,
      });
      // Both reservations created, quantities intact — ordering only affects lock sequence.
      expect(tx.inventoryReservation.create).toHaveBeenCalledTimes(2);
      const created = (tx.inventoryReservation.create as jest.Mock).mock.calls.map((c) => c[0].data);
      expect(created).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ productId: 'p1', reservedQty: 2, status: ReservationStatus.RESERVED }),
          expect.objectContaining({ productId: 'p2', reservedQty: 3, status: ReservationStatus.RESERVED }),
        ]),
      );
    });

    it('rollback behavior unchanged: still throws on insufficient stock (caller tx rolls back)', async () => {
      // p1 has stock, p2 is exhausted → throws after locking in sorted order.
      const tx = buildTx({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        $queryRaw: jest.fn().mockImplementation(async (sql: any) => [{ stock: sql.values[0] === 'p2' ? 0 : 100 }]),
        inventoryReservation: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { reservedQty: 0 } }),
          create: jest.fn().mockResolvedValue({ id: 'res-x' }),
        },
        inventoryReservationHistory: { create: jest.fn() },
      });
      const { service } = svc();
      await expect(
        service.reserveForOrder(tx as never, {
          orderId: 'o1',
          items: [{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }],
          paymentMethod: PaymentMethod.QRIS,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
