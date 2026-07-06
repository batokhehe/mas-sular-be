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
    order: { update: jest.fn().mockResolvedValue({}) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
  };
}

function buildPrisma(order: unknown = ORDER, tx = buildTx()) {
  return {
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET) },
    shipment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
    // order → SHIPPED
    expect(prisma.__tx.order.update.mock.calls[0][0].data.status).toBe('SHIPPED');
    // WhatsApp enqueued with tracking
    const notif = prisma.__tx.notificationOutbox.create.mock.calls[0][0].data;
    expect(notif.template).toBe('order.shipped');
    expect(notif.payload.trackingNumber).toBe('JNE123');
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
