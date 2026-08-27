import { ShipmentStatus } from '@prisma/client';
import { ShipmentSyncService } from '../../src/modules/shipment/shipment-sync.service';
import { ShipmentStatusMapper } from '../../src/modules/shipment/shipment-status.mapper';

function shipment(status: ShipmentStatus) {
  return {
    id: 'sh1',
    provider: 'jne',
    service: 'REG',
    trackingNumber: 'JNE1',
    status,
    order: {
      id: 'o1',
      orderNumber: 'INV-1',
      status: 'DELIVERING',
      user: { name: 'Budi', email: 'b@test.com', phone: null },
      address: { phone: '628123' },
    },
  };
}

function buildTx() {
  return {
    // PAXELBOX-25: the transition is CAS-claimed via updateMany; count 1
    // means this run won the claim and may record the rest.
    shipment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    shipmentHistory: { create: jest.fn().mockResolvedValue({}) },
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
  };
}

function buildPrisma(shipments: unknown[], tx = buildTx()) {
  return {
    shipment: { findMany: jest.fn().mockResolvedValue(shipments) },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
}

function buildService(prisma: unknown, providerStatus: string) {
  const provider = { trackShipmentRaw: jest.fn().mockResolvedValue({ providerStatus, rawPayload: { s: providerStatus } }) };
  const factory = { get: jest.fn().mockReturnValue(provider) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ShipmentSyncService(prisma as any, factory as any, new ShipmentStatusMapper());
  return { service, provider };
}

describe('ShipmentSyncService', () => {
  it('applies a real status change: updates shipment, appends history, advances order, notifies', async () => {
    const prisma = buildPrisma([shipment(ShipmentStatus.IN_TRANSIT)]);
    const { service } = buildService(prisma, 'DELIVERED');

    const changed = await service.syncAll();

    expect(changed).toBe(1);
    expect(prisma.__tx.shipment.updateMany.mock.calls[0][0].data.status).toBe(ShipmentStatus.DELIVERED);
    expect(prisma.__tx.shipmentHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ providerStatus: 'DELIVERED', mappedStatus: ShipmentStatus.DELIVERED }),
      }),
    );
    const flip = prisma.__tx.order.updateMany.mock.calls[0][0];
    expect(flip.data.status).toBe('DELIVERED');
    expect(flip.where.status.in).not.toContain('CANCELLED'); // F4: never revives a cancelled order
    expect(prisma.__tx.orderEvent.create).toHaveBeenCalled();
    const notif = prisma.__tx.notificationOutbox.create.mock.calls[0][0].data;
    expect(notif.template).toBe('shipment.status');
    expect(notif.payload.shipmentStatus).toBe(ShipmentStatus.DELIVERED);
  });

  it('is idempotent: a duplicate provider response (same mapped status) writes nothing', async () => {
    const prisma = buildPrisma([shipment(ShipmentStatus.IN_TRANSIT)]);
    const { service } = buildService(prisma, 'ON PROCESS'); // → IN_TRANSIT (unchanged)

    const changed = await service.syncAll();

    expect(changed).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ignores unknown provider statuses (no DB write, no downgrade)', async () => {
    const prisma = buildPrisma([shipment(ShipmentStatus.IN_TRANSIT)]);
    const { service } = buildService(prisma, 'GIBBERISH');

    const changed = await service.syncAll();

    expect(changed).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
