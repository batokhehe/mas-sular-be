import { InventoryReservationWorker } from '../../src/modules/inventory/inventory-reservation.worker';

function build(due: Array<{ id: string }>, expireResults: boolean[]) {
  const prisma = {
    inventoryReservation: { findMany: jest.fn().mockResolvedValue(due) },
  };
  let call = 0;
  const reservations = { expireReservation: jest.fn().mockImplementation(() => Promise.resolve(expireResults[call++])) };
  const metrics = { expired: jest.fn(), failure: jest.fn() };
  const config = { enabled: true, pollIntervalMs: 1000, initialDelayMs: 0, batchSize: 100, healthLogIntervalMs: 1000 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const worker = new InventoryReservationWorker(prisma as any, reservations as any, metrics as any, config as any);
  return { worker, prisma, reservations, metrics };
}

describe('InventoryReservationWorker', () => {
  it('releases every due reservation and records the metric', async () => {
    const { worker, reservations, metrics } = build([{ id: 'r1' }, { id: 'r2' }], [true, true]);
    const released = await worker.releaseExpired();
    expect(released).toBe(2);
    expect(reservations.expireReservation).toHaveBeenCalledTimes(2);
    expect(metrics.expired).toHaveBeenCalledWith(2);
  });

  it('counts only CAS-winning transitions (idempotent under races)', async () => {
    const { worker, metrics } = build([{ id: 'r1' }, { id: 'r2' }], [true, false]);
    const released = await worker.releaseExpired();
    expect(released).toBe(1);
    expect(metrics.expired).toHaveBeenCalledWith(1);
  });

  it('continues past a failing reservation and records the failure', async () => {
    const prisma = { inventoryReservation: { findMany: jest.fn().mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]) } };
    const reservations = {
      expireReservation: jest
        .fn()
        .mockRejectedValueOnce(new Error('db blip'))
        .mockResolvedValueOnce(true),
    };
    const metrics = { expired: jest.fn(), failure: jest.fn() };
    const config = { enabled: true, pollIntervalMs: 1000, initialDelayMs: 0, batchSize: 100, healthLogIntervalMs: 1000 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const worker = new InventoryReservationWorker(prisma as any, reservations as any, metrics as any, config as any);
    const released = await worker.releaseExpired();
    expect(released).toBe(1);
    expect(metrics.failure).toHaveBeenCalledTimes(1);
  });
});
