import { ShipmentStatus } from '@prisma/client';
import { ShipmentService } from '../../src/modules/shipment/shipment.service';

/**
 * PAXELBOX-18: the service a customer chose and PAID for at checkout
 * (`Order.shippingService`) is authoritative for booking. `Shipment.service` is
 * a record, not an instruction — it may hold a display label, and nothing an
 * operator does to it may change what the courier is asked to carry.
 *
 * This matters because there is NO repricing, refund, or price-adjustment
 * mechanism anywhere in this codebase: booking a different service than the one
 * paid for could not be settled financially.
 */

const PICKUP = '2026-09-01T10:30:00.000Z';

function order(shippingService: string | null, shipmentService: string) {
  return {
    id: 'o1',
    orderNumber: 'BMS-1',
    totalPrice: 250000,
    paymentMethod: 'GATEWAY',
    shippingProvider: shipmentService.toLowerCase().includes('jne') || shipmentService === 'REG' ? 'jne' : 'paxel',
    shippingService,
    shippingServiceName: null,
    shipment: {
      id: 'sh1',
      provider: 'paxel',
      service: shipmentService,
      status: ShipmentStatus.RATE_SELECTED,
      trackingNumber: null,
      metadata: null,
    },
    address: {
      recipientName: 'Budi', phone: '628123', addressDetail: 'Jl. Test 1', fullAddress: 'Jl. Test 1',
      postalCode: '40131', notes: null, latitude: -6.8, longitude: 107.5,
      province: { name: 'Jawa Barat' }, city: { name: 'Kota Bandung' },
      district: { name: 'Sukajadi' }, village: { name: 'Pasteur' },
    },
    user: { name: 'Budi', email: 'budi@test.com', phone: null },
    items: [{
      quantity: 1, productName: 'Bakso', unitPrice: 45000, weightGram: 450,
      lengthCm: 20, widthCm: 15, heightCm: 10, isFragile: false,
      product: { sku: 'SKU-1', name: 'Bakso', category: { name: 'Makanan' } },
    }],
  };
}

const OUTLET = {
  id: 'out1', name: 'Pusat', postalCode: '40111', addressDetail: 'Jl. Outlet No.1',
  latitude: -6.9, longitude: 107.6,
  province: { name: 'Jawa Barat' }, city: { name: 'Kota Bandung' },
  district: { name: 'Coblong' }, village: { name: 'Dago' },
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
      // Persist like the real DB: prepareForOrder writes the pickup slot then
      // re-reads the order to book it.
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
      trackingNumber: 'AWB-1', providerShipmentId: 'AWB-1',
      status: ShipmentStatus.CREATED, rawPayload: { data: { airwaybill_code: 'AWB-1' } },
    }),
  };
  const service = new ShipmentService(prisma as never, { get: () => provider } as never);
  return { service, provider, theOrder, tx };
}

/** The service actually handed to the courier provider. */
const bookedService = (provider: { createShipment: jest.Mock }) =>
  provider.createShipment.mock.calls[0][0].service;

describe('the paid service is what gets booked', () => {
  it.each([
    ['PAXEL_INSTANT'],
    ['PAXEL_SAMEDAY'],
    ['PAXEL_NEXTDAY'],
    ['PAXEL_REGULAR'],
    ['REG'],
  ])('Order.shippingService = %s is booked verbatim', async (paid) => {
    const { service, provider } = build(order(paid, 'anything else entirely'));

    await service.prepareForOrder('o1', { pickupAtIso: PICKUP });

    expect(bookedService(provider)).toBe(paid);
  });

  it('a display label on the shipment cannot override the paid code', async () => {
    // The normal state of a never-prepared shipment: checkout stores the label.
    const { service, provider } = build(order('PAXEL_INSTANT', 'Paxel Same Day'));

    await service.prepareForOrder('o1', { pickupAtIso: PICKUP });

    expect(bookedService(provider)).toBe('PAXEL_INSTANT');
  });

  it('another Paxel CODE on the shipment cannot override the paid code', async () => {
    // What a legacy override would have left behind.
    const { service, provider } = build(order('PAXEL_INSTANT', 'PAXEL_NEXTDAY'));

    await service.prepareForOrder('o1', { pickupAtIso: PICKUP });

    expect(bookedService(provider)).toBe('PAXEL_INSTANT');
  });

  it('falls back to Shipment.service only when the order has no service', async () => {
    const { service, provider } = build(order(null, 'PAXEL_NEXTDAY'));

    await service.prepareForOrder('o1', { pickupAtIso: PICKUP });

    // Existing fallback semantics, preserved rather than reinvented.
    expect(bookedService(provider)).toBe('PAXEL_NEXTDAY');
  });
});

describe('preparation does not touch what the customer paid for', () => {
  it('schedules the pickup without rewriting the service', async () => {
    const { service, theOrder } = build(order('PAXEL_INSTANT', 'Paxel Instant'));

    await service.prepareForOrder('o1', { pickupAtIso: PICKUP });

    expect(theOrder.shippingService).toBe('PAXEL_INSTANT');
    // The pickup slot is persisted — that is what preparing is for.
    expect(theOrder.shipment.metadata).toBeTruthy();
  });

  it('the booking never writes Order.shippingService', async () => {
    const { service, tx } = build(order('PAXEL_INSTANT', 'Paxel Instant'));

    await service.prepareForOrder('o1', { pickupAtIso: PICKUP });

    // Booking flips status/trackingNumber and nothing else. If a future change
    // made an override "stick" by rewriting the order, it would land here — and
    // silently change the service a customer paid for.
    for (const call of tx.order.updateMany.mock.calls) {
      expect(call[0].data).not.toHaveProperty('shippingService');
    }
    expect(tx.order.updateMany).toHaveBeenCalled();
  });
});
