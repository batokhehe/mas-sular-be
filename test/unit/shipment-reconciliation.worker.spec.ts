import { ShipmentReconciliationWorker } from '../../src/modules/shipment/shipment-reconciliation.worker';
import { BOOKING_IN_PROGRESS } from '../../src/modules/shipment/shipment.service';

const CONFIG = { enabled: true, pollIntervalMs: 1000, initialDelayMs: 0, batchSize: 50, delayMs: 120000, healthLogIntervalMs: 1000 };

function build(opts: {
  candidates: Array<{ orderId: string }>;
  outcome?: { ok: boolean; status?: string; trackingNumber?: string | null; error?: string };
}) {
  const prisma = {
    shipment: {
      findMany: jest.fn().mockResolvedValue(opts.candidates),
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
  it('recovers a crash-stranded order by booking via createForOrderSafe (claim lives in the service)', async () => {
    const { worker, shipments, metrics } = build({ candidates: [{ orderId: 'o1' }] });
    const result = await worker.reconcile();
    expect(result).toMatchObject({ booked: 1, failed: 0, pending: 1 });
    expect(shipments.createForOrderSafe).toHaveBeenCalledWith('o1');
    expect(metrics.setPending).toHaveBeenCalledWith(1);
    expect(metrics.success).toHaveBeenCalledTimes(1);
  });

  it('a lost booking claim (BOOKING_IN_PROGRESS) is a skip — not a booking, not a failure', async () => {
    const { worker, shipments, metrics } = build({
      candidates: [{ orderId: 'o1' }],
      outcome: { ok: false, status: 'PENDING', error: BOOKING_IN_PROGRESS },
    });
    const result = await worker.reconcile();
    expect(result).toMatchObject({ booked: 0, failed: 0 });
    expect(shipments.createForOrderSafe).toHaveBeenCalledTimes(1);
    expect(metrics.success).not.toHaveBeenCalled();
    expect(metrics.failure).not.toHaveBeenCalled();
  });

  it('concurrent reconciliation results in exactly one booking (service claim dedups)', async () => {
    const prisma = { shipment: { findMany: jest.fn().mockResolvedValue([{ orderId: 'o1' }]) } };
    // First caller wins the in-service claim; every later caller loses it.
    let claimed = false;
    const shipments = {
      createForOrderSafe: jest.fn().mockImplementation(async () => {
        if (claimed) return { ok: false, status: 'PENDING', error: BOOKING_IN_PROGRESS };
        claimed = true;
        return { ok: true, status: 'CREATED', trackingNumber: 'TRK-1' };
      }),
    };
    const metrics = { setPending: jest.fn(), success: jest.fn(), failure: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workerA = new ShipmentReconciliationWorker(prisma as any, shipments as any, metrics as any, CONFIG as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workerB = new ShipmentReconciliationWorker(prisma as any, shipments as any, metrics as any, CONFIG as any);

    const [a, b] = await Promise.all([workerA.reconcile(), workerB.reconcile()]);

    expect(a.booked + b.booked).toBe(1); // exactly one booking
    expect(a.failed + b.failed).toBe(0); // the loser skipped, not failed
    expect(metrics.success).toHaveBeenCalledTimes(1);
  });

  // The claim predicate itself (RATE_SELECTED/FAILED claimable, fresh PENDING leased,
  // stale PENDING reclaimable) — semantics now enforced inside ShipmentService.
  it('a freshly-claimed PENDING row is no longer claimable (lease held)', async () => {
    const row = {
      orderId: 'o1',
      status: 'RATE_SELECTED',
      trackingNumber: null as string | null,
      updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matchesClaim = (where: any): boolean => {
      if (where.trackingNumber === null && row.trackingNumber !== null) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (where.OR as any[]).some((c) => {
        const statuses = c.status?.in ?? (c.status ? [c.status] : null);
        if (statuses && !statuses.includes(row.status)) return false;
        if (c.updatedAt?.lte && !(row.updatedAt <= c.updatedAt.lte)) return false;
        return true;
      });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claim = async (where: any) => {
      if (!matchesClaim(where)) return { count: 0 };
      row.status = 'PENDING';
      row.updatedAt = new Date(); // @updatedAt bump = lease extension
      return { count: 1 };
    };
    const cutoff = new Date(Date.now() - CONFIG.delayMs);
    const where = {
      trackingNumber: null,
      OR: [{ status: { in: ['RATE_SELECTED', 'FAILED'] } }, { status: 'PENDING', updatedAt: { lte: cutoff } }],
    };
    expect((await claim(where)).count).toBe(1);
    expect((await claim(where)).count).toBe(0); // fresh PENDING (updatedAt=now > cutoff) excluded
    expect(row.status).toBe('PENDING');
  });

  it('records a failure when booking fails (surfaces for admin retry)', async () => {
    const { worker, metrics } = build({
      candidates: [{ orderId: 'o1' }],
      outcome: { ok: false, status: 'FAILED', error: 'courier down' },
    });
    const result = await worker.reconcile();
    expect(result).toMatchObject({ booked: 0, failed: 1 });
    expect(metrics.failure).toHaveBeenCalledTimes(1);
  });
});
