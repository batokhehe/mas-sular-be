import { ShipmentReconciliationWorker } from '../../src/modules/shipment/shipment-reconciliation.worker';

const CONFIG = { enabled: true, pollIntervalMs: 1000, initialDelayMs: 0, batchSize: 50, delayMs: 120000, healthLogIntervalMs: 1000 };

function build(opts: {
  candidates: Array<{ orderId: string }>;
  claim: jest.Mock;
  outcome?: { ok: boolean; status?: string; trackingNumber?: string | null; error?: string };
}) {
  const prisma = {
    shipment: {
      findMany: jest.fn().mockResolvedValue(opts.candidates),
      updateMany: opts.claim,
    },
  };
  const shipments = {
    createForOrderSafe: jest
      .fn()
      .mockResolvedValue(opts.outcome ?? { ok: true, status: 'CREATED', trackingNumber: 'TRK-1' }),
  };
  const metrics = { setPending: jest.fn(), success: jest.fn(), failure: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const worker = new ShipmentReconciliationWorker(prisma as any, shipments as any, metrics as any, CONFIG as any);
  return { worker, prisma, shipments, metrics };
}

describe('ShipmentReconciliationWorker', () => {
  it('recovers a crash-stranded order: claims it and books via createForOrderSafe', async () => {
    const { worker, shipments, metrics } = build({
      candidates: [{ orderId: 'o1' }],
      claim: jest.fn().mockResolvedValue({ count: 1 }),
    });
    const result = await worker.reconcile();
    expect(result).toMatchObject({ booked: 1, failed: 0, pending: 1 });
    expect(shipments.createForOrderSafe).toHaveBeenCalledWith('o1');
    expect(metrics.setPending).toHaveBeenCalledWith(1);
    expect(metrics.success).toHaveBeenCalledTimes(1);
  });

  it('safely skips an order already booked/claimed elsewhere (CAS loses → no double booking)', async () => {
    const { worker, shipments, metrics } = build({
      candidates: [{ orderId: 'o1' }],
      claim: jest.fn().mockResolvedValue({ count: 0 }), // another instance already claimed/booked
    });
    const result = await worker.reconcile();
    expect(result.booked).toBe(0);
    expect(shipments.createForOrderSafe).not.toHaveBeenCalled();
    expect(metrics.success).not.toHaveBeenCalled();
  });

  // In-memory shipment row that honours the REAL updateMany predicate semantics
  // (match → apply data + bump updatedAt), so exclusivity emerges from the query,
  // not from a canned count sequence.
  function makeStore() {
    const row = {
      orderId: 'o1',
      status: 'RATE_SELECTED',
      trackingNumber: null as string | null,
      updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // old (past cutoff)
      orderCreatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      paymentStatus: 'PAID',
    };
    const matchesClaim = (where: any): boolean => {
      if (where.orderId !== row.orderId) return false;
      if (where.trackingNumber === null && row.trackingNumber !== null) return false;
      return (where.OR as any[]).some((c) => {
        if (c.status && c.status !== row.status) return false;
        if (c.updatedAt?.lte && !(row.updatedAt <= c.updatedAt.lte)) return false;
        return true;
      });
    };
    const prisma = {
      shipment: {
        findMany: jest.fn().mockImplementation(async () => {
          // Candidate: RATE_SELECTED (old order) OR stale PENDING — same shape as claim.
          const cutoff = new Date(Date.now() - CONFIG.delayMs);
          const isCandidate =
            row.trackingNumber === null &&
            row.paymentStatus === 'PAID' &&
            ((row.status === 'RATE_SELECTED' && row.orderCreatedAt <= cutoff) ||
              (row.status === 'PENDING' && row.updatedAt <= cutoff));
          return isCandidate ? [{ orderId: row.orderId }] : [];
        }),
        updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
          if (!matchesClaim(where)) return { count: 0 };
          row.status = data.status;
          row.updatedAt = new Date(); // Prisma bumps @updatedAt → extends the lease
          return { count: 1 };
        }),
      },
    };
    return { prisma, row };
  }

  it('concurrent reconciliation books the shipment exactly once (real updateMany semantics)', async () => {
    const { prisma } = makeStore();
    const shipments = { createForOrderSafe: jest.fn().mockResolvedValue({ ok: true, trackingNumber: 'TRK-1' }) };
    const metrics = { setPending: jest.fn(), success: jest.fn(), failure: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workerA = new ShipmentReconciliationWorker(prisma as any, shipments as any, metrics as any, CONFIG as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workerB = new ShipmentReconciliationWorker(prisma as any, shipments as any, metrics as any, CONFIG as any);

    await Promise.all([workerA.reconcile(), workerB.reconcile()]);

    // The winner flips RATE_SELECTED→PENDING and bumps updatedAt; the loser's claim
    // no longer matches (fresh PENDING > cutoff) → count 0 → exactly one booking.
    expect(shipments.createForOrderSafe).toHaveBeenCalledTimes(1);
  });

  it('a freshly-claimed PENDING row is no longer claimable (lease held)', async () => {
    const { prisma, row } = makeStore();
    const cutoff = new Date(Date.now() - CONFIG.delayMs);
    const claimWhere = {
      orderId: 'o1',
      trackingNumber: null,
      OR: [{ status: 'RATE_SELECTED' }, { status: 'PENDING', updatedAt: { lte: cutoff } }],
    };
    const first = await prisma.shipment.updateMany({ where: claimWhere, data: { status: 'PENDING' } });
    const second = await prisma.shipment.updateMany({ where: claimWhere, data: { status: 'PENDING' } });
    expect(first.count).toBe(1);
    expect(second.count).toBe(0); // fresh PENDING (updatedAt=now > cutoff) is excluded
    expect(row.status).toBe('PENDING');
  });

  it('records a failure when booking fails (surfaces for admin retry)', async () => {
    const { worker, metrics } = build({
      candidates: [{ orderId: 'o1' }],
      claim: jest.fn().mockResolvedValue({ count: 1 }),
      outcome: { ok: false, status: 'FAILED', error: 'courier down' },
    });
    const result = await worker.reconcile();
    expect(result).toMatchObject({ booked: 0, failed: 1 });
    expect(metrics.failure).toHaveBeenCalledTimes(1);
  });
});
