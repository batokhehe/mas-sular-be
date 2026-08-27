import { ShipmentStatus } from '@prisma/client';
import { ShipmentService } from '../../src/modules/shipment/shipment.service';

/**
 * Prepare Shipment is a BATCH action, and the selected orders may have bought
 * different services. The panel used to send its dropdown value for the whole
 * batch, which overwrote Shipment.service on every order — including ones that
 * bought something else.
 *
 * Booking itself was never wrong (createForOrder resolves
 * `order.shippingService ?? shipment.service`, so the Order always won), but the
 * shipment RECORD ended up disagreeing with its order, and that record is what
 * the Admin Shipping page and the delivered-WhatsApp message read.
 *
 * These tests pin the backend half: omitting `service` must leave each
 * shipment's own service untouched, while an explicit service still overrides.
 */

const PICKUP = '2026-09-01T10:30:00.000Z';

function order(shippingService: string, shipmentService: string, id = 'o1') {
  return {
    id,
    orderNumber: `BMS-${id}`,
    totalPrice: 250000,
    paymentMethod: 'GATEWAY',
    shippingProvider: 'paxel',
    shippingService,
    shippingServiceName: null,
    shipment: {
      id: `sh-${id}`,
      provider: 'paxel',
      service: shipmentService,
      status: ShipmentStatus.RATE_SELECTED,
      trackingNumber: null,
      metadata: null,
    },
    address: {
      recipientName: 'Budi',
      phone: '628123',
      addressDetail: 'Jl. Test 1',
      fullAddress: 'Jl. Test 1',
      postalCode: '40131',
      notes: null,
      latitude: -6.8,
      longitude: 107.5,
      province: { name: 'Jawa Barat' },
      city: { name: 'Kota Bandung' },
      district: { name: 'Sukajadi' },
      village: { name: 'Pasteur' },
    },
    user: { name: 'Budi', email: 'budi@test.com', phone: null },
    items: [
      {
        quantity: 1,
        productName: 'Bakso',
        unitPrice: 45000,
        weightGram: 450,
        lengthCm: 20,
        widthCm: 15,
        heightCm: 10,
        isFragile: false,
        product: { sku: 'SKU-1', name: 'Bakso', category: { name: 'Makanan' } },
      },
    ],
  };
}

const OUTLET = {
  id: 'out1',
  name: 'Pusat',
  postalCode: '40111',
  addressDetail: 'Jl. Outlet No.1',
  latitude: -6.9,
  longitude: 107.6,
  province: { name: 'Jawa Barat' },
  city: { name: 'Kota Bandung' },
  district: { name: 'Coblong' },
  village: { name: 'Dago' },
};

function build(theOrder: ReturnType<typeof order>) {
  const tx = {
    shipment: { update: jest.fn().mockResolvedValue({}) },
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(theOrder) },
    outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET), findUnique: jest.fn().mockResolvedValue(OUTLET) },
    shipment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(theOrder.shipment),
      // Persist like the real DB would: prepareForOrder writes the pickup slot
      // and then re-reads the order to book it, so a no-op mock would leave the
      // shipment unscheduled and the booking (correctly) refused.
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        Object.assign(theOrder.shipment, data);
        return Promise.resolve(theOrder.shipment);
      }),
    },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  const provider = {
    name: 'paxel',
    requiresPickupSchedule: true,
    createShipment: jest.fn().mockResolvedValue({
      trackingNumber: 'AWB-1',
      providerShipmentId: 'AWB-1',
      status: ShipmentStatus.CREATED,
      rawPayload: { data: { airwaybill_code: 'AWB-1' } },
    }),
  };
  const factory = { get: jest.fn().mockReturnValue(provider) };
  const service = new ShipmentService(prisma as never, factory as never);
  return { service, prisma, provider };
}

/** The `data` of the prepare-time shipment.update (metadata + maybe service). */
function prepareUpdateData(prisma: ReturnType<typeof build>['prisma']) {
  return prisma.shipment.update.mock.calls[0][0].data as Record<string, unknown>;
}

describe('prepareForOrder with service OMITTED', () => {
  it('does not touch Shipment.service', async () => {
    const { service, prisma } = build(order('PAXEL_INSTANT', 'Paxel Instant'));

    await service.prepareForOrder('o1', { pickupAtIso: PICKUP });

    const data = prepareUpdateData(prisma);
    expect(data).not.toHaveProperty('service');
    // The pickup slot is still persisted — that is the point of preparing.
    expect(data).toHaveProperty('metadata');
  });

  it('books each order with its OWN service (mixed batch)', async () => {
    const a = build(order('PAXEL_INSTANT', 'Paxel Instant', 'oA'));
    const b = build(order('PAXEL_SAMEDAY', 'Paxel Same Day', 'oB'));

    await a.service.prepareForOrder('oA', { pickupAtIso: PICKUP });
    await b.service.prepareForOrder('oB', { pickupAtIso: PICKUP });

    // Neither shipment record was rewritten…
    expect(prepareUpdateData(a.prisma)).not.toHaveProperty('service');
    expect(prepareUpdateData(b.prisma)).not.toHaveProperty('service');
    // …and each booking used the service its own order bought.
    expect(a.provider.createShipment.mock.calls[0][0].service).toBe('PAXEL_INSTANT');
    expect(b.provider.createShipment.mock.calls[0][0].service).toBe('PAXEL_SAMEDAY');
  });
});

describe('prepareForOrder with an EXPLICIT service', () => {
  it('still overrides Shipment.service, unchanged behaviour', async () => {
    const { service, prisma } = build(order('PAXEL_INSTANT', 'Paxel Instant'));

    await service.prepareForOrder('o1', { pickupAtIso: PICKUP, service: 'PAXEL_NEXTDAY' });

    expect(prepareUpdateData(prisma)).toMatchObject({ service: 'PAXEL_NEXTDAY' });
  });
});

describe('CREATE service resolution is unchanged', () => {
  it('prefers Order.shippingService over Shipment.service', async () => {
    const { service, provider } = build(order('PAXEL_INSTANT', 'Paxel Same Day'));

    await service.prepareForOrder('o1', { pickupAtIso: PICKUP });

    expect(provider.createShipment.mock.calls[0][0].service).toBe('PAXEL_INSTANT');
  });

  it('falls back to Shipment.service when the order has none', async () => {
    const withoutOrderService = order('PAXEL_INSTANT', 'PAXEL_NEXTDAY');
    // Existing fallback semantics, preserved rather than reinvented.
    (withoutOrderService as { shippingService: string | null }).shippingService = null;
    const { service, provider } = build(withoutOrderService);

    await service.prepareForOrder('o1', { pickupAtIso: PICKUP });

    expect(provider.createShipment.mock.calls[0][0].service).toBe('PAXEL_NEXTDAY');
  });
});
