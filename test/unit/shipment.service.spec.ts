import { ShipmentStatus } from '@prisma/client';
import { ShipmentService } from '../../src/modules/shipment/shipment.service';

const ORDER = {
  id: 'o1',
  orderNumber: 'INV-1',
  shippingProvider: 'jne',
  shippingService: 'REG',
  shippingServiceName: 'JNE Regular',
  shipment: { id: 'sh1', provider: 'jne', service: 'REG', status: ShipmentStatus.RATE_SELECTED, trackingNumber: null },
  address: {
    recipientName: 'Budi',
    phone: '628123',
    addressDetail: 'Jl. Test 1',
    fullAddress: 'Jl. Test 1',
    postalCode: '40131',
    latitude: -6.8,
    longitude: 107.5,
  },
  user: { name: 'Budi', email: 'budi@test.com', phone: null },
  items: [{ quantity: 2 }],
};

const OUTLET = { id: 'out1', name: 'Pusat', postalCode: '40111', latitude: -6.9, longitude: 107.6 };

function buildTx() {
  return {
    shipment: { update: jest.fn().mockResolvedValue({}) },
    // Order advance is a legal-transition CAS (F4) + explicit event row.
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
  };
}

function buildPrisma(order: unknown = ORDER, tx = buildTx()) {
  return {
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET) },
    shipment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }), // booking claim (F3)
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
}

function buildFactory(provider: unknown) {
  return { get: jest.fn().mockReturnValue(provider) };
}

describe('ShipmentService', () => {
  it('creates a shipment, snapshots it, marks the order SHIPPED, and enqueues WhatsApp', async () => {
    const prisma = buildPrisma();
    const provider = {
      name: 'jne',
      createShipment: jest.fn().mockResolvedValue({
        trackingNumber: 'JNE123',
        providerShipmentId: 'JNE123',
        status: ShipmentStatus.CREATED,
        rawPayload: { ok: true },
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new ShipmentService(prisma as any, buildFactory(provider) as any);

    const outcome = await service.createForOrder('o1');

    expect(outcome).toMatchObject({ ok: true, trackingNumber: 'JNE123' });
    expect(provider.createShipment).toHaveBeenCalledTimes(1);
    // shipment snapshot
    expect(prisma.__tx.shipment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trackingNumber: 'JNE123', providerShipmentId: 'JNE123', status: ShipmentStatus.CREATED }),
      }),
    );
    // booking claim taken BEFORE the provider call (F3)
    expect(prisma.shipment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: ShipmentStatus.PENDING } }),
    );
    // order → SHIPPED via legal-transition CAS (F4) + event row
    const flip = prisma.__tx.order.updateMany.mock.calls[0][0];
    expect(flip.data.status).toBe('SHIPPED');
    expect(flip.where.status.in).not.toContain('CANCELLED'); // never resurrects a cancelled order
    expect(prisma.__tx.orderEvent.create).toHaveBeenCalled();
    // WhatsApp enqueued with tracking
    const notif = prisma.__tx.notificationOutbox.create.mock.calls[0][0].data;
    expect(notif.template).toBe('order.shipped');
    expect(notif.payload.trackingNumber).toBe('JNE123');
  });

  it('F3: a lost booking claim never reaches the courier (concurrent booking in flight)', async () => {
    const prisma = buildPrisma();
    prisma.shipment.updateMany.mockResolvedValue({ count: 0 }); // claim lost
    prisma.shipment.findUnique.mockResolvedValue({ id: 'sh1', status: ShipmentStatus.PENDING, trackingNumber: null });
    const provider = { name: 'jne', createShipment: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new ShipmentService(prisma as any, buildFactory(provider) as any);

    const outcome = await service.createForOrder('o1');

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('already in progress');
    expect(provider.createShipment).not.toHaveBeenCalled(); // no duplicate courier booking
  });

  it('F3: a lost claim whose winner already booked returns that tracking (idempotent success)', async () => {
    const prisma = buildPrisma();
    prisma.shipment.updateMany.mockResolvedValue({ count: 0 });
    prisma.shipment.findUnique.mockResolvedValue({ id: 'sh1', status: ShipmentStatus.CREATED, trackingNumber: 'WINNER-1' });
    const provider = { name: 'jne', createShipment: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new ShipmentService(prisma as any, buildFactory(provider) as any);

    const outcome = await service.createForOrder('o1');

    expect(outcome).toMatchObject({ ok: true, trackingNumber: 'WINNER-1' });
    expect(provider.createShipment).not.toHaveBeenCalled();
  });

  it('F4: an order cancelled mid-booking keeps CANCELLED — tracking recorded, no SHIPPED event, no WhatsApp', async () => {
    const tx = buildTx();
    tx.order.updateMany.mockResolvedValue({ count: 0 }); // CAS lost: order no longer shippable
    const prisma = buildPrisma(ORDER, tx);
    const provider = {
      name: 'jne',
      createShipment: jest.fn().mockResolvedValue({
        trackingNumber: 'JNE123', providerShipmentId: 'JNE123', status: ShipmentStatus.CREATED, rawPayload: {},
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new ShipmentService(prisma as any, buildFactory(provider) as any);

    const outcome = await service.createForOrder('o1');

    expect(outcome.ok).toBe(true); // courier booking itself succeeded and is snapshotted
    expect(tx.shipment.update).toHaveBeenCalled(); // tracking kept for ops
    expect(tx.orderEvent.create).not.toHaveBeenCalled();
    expect(tx.notificationOutbox.create).not.toHaveBeenCalled(); // customer NOT told it shipped
  });

  it('is idempotent when a tracking number already exists (no provider call)', async () => {
    const order = { ...ORDER, shipment: { ...ORDER.shipment, trackingNumber: 'EXISTING', status: ShipmentStatus.CREATED } };
    const prisma = buildPrisma(order);
    const provider = { name: 'jne', createShipment: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new ShipmentService(prisma as any, buildFactory(provider) as any);

    const outcome = await service.createForOrder('o1');
    expect(outcome.trackingNumber).toBe('EXISTING');
    expect(provider.createShipment).not.toHaveBeenCalled();
  });

  it('createForOrderSafe marks the shipment FAILED when the provider fails (payment stays PAID)', async () => {
    const prisma = buildPrisma();
    const provider = { name: 'jne', createShipment: jest.fn().mockRejectedValue(new Error('courier 503')) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new ShipmentService(prisma as any, buildFactory(provider) as any);

    const outcome = await service.createForOrderSafe('o1');

    expect(outcome).toMatchObject({ ok: false, status: ShipmentStatus.FAILED });
    expect(prisma.shipment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'o1', trackingNumber: null },
        data: expect.objectContaining({ status: ShipmentStatus.FAILED }),
      }),
    );
  });
});
