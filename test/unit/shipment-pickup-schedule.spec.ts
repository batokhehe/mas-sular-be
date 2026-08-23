import { ShipmentStatus } from '@prisma/client';
import { AWAITING_PICKUP_SCHEDULE, BOOKING_IN_PROGRESS, ShipmentService } from '../../src/modules/shipment/shipment.service';
import { readPickupDatetime, withPickupDatetime } from '../../src/modules/shipment/shipment-metadata';

/**
 * Admin-supplied pickup schedule (PAXEL-B2b).
 *
 * Paxel will not book without a pickup slot, and a pickup slot is a real-world
 * commitment somebody has to keep — so it is never derived from the clock. The
 * consequence is that the automatic paths (payment settlement, the
 * reconciliation sweep) must be able to encounter an unscheduled shipment and
 * leave it alone, rather than attempt a booking that is guaranteed to fail and
 * mark it FAILED.
 */

const PICKUP = '2026-09-01T10:30:00.000Z';

function order(over: Record<string, unknown> = {}, shipmentOver: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNumber: 'BMS-1',
    totalPrice: 250000,
    paymentMethod: 'BANK_TRANSFER',
    shippingProvider: 'paxel',
    shippingService: 'PAXEL_SAMEDAY',
    shippingServiceName: 'Paxel Same Day',
    shipment: {
      id: 'sh1',
      provider: 'paxel',
      service: 'PAXEL_SAMEDAY',
      status: ShipmentStatus.RATE_SELECTED,
      trackingNumber: null,
      metadata: null,
      ...shipmentOver,
    },
    address: {
      recipientName: 'Budi',
      phone: '628123',
      addressDetail: 'Jl. Test 1',
      fullAddress: 'Jl. Test 1',
      postalCode: '40131',
      notes: 'pagar hijau',
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
        quantity: 2,
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
    ...over,
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

function buildTx() {
  return {
    shipment: { update: jest.fn().mockResolvedValue({}) },
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
  };
}

function build(theOrder: unknown = order(), over: { claimCount?: number } = {}) {
  const tx = buildTx();
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(theOrder) },
    outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET), findUnique: jest.fn().mockResolvedValue(OUTLET) },
    shipment: {
      updateMany: jest.fn().mockResolvedValue({ count: over.claimCount ?? 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
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
      rawPayload: { data: { airwaybill_code: 'AWB-1', shipping_cost: 30000 } },
    }),
  };
  const factory = { get: jest.fn().mockReturnValue(provider) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ShipmentService(prisma as any, factory as any);
  return { service, prisma, provider, tx };
}

// ============================================================= the guard ======

describe('Booking waits for an admin-selected pickup time', () => {
  it('does NOT call the courier when no pickup time has been chosen', async () => {
    const { service, provider, prisma } = build();
    const outcome = await service.createForOrder('o1');

    expect(provider.createShipment).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, error: AWAITING_PICKUP_SCHEDULE });
    // Crucially it also does not CLAIM: the shipment stays exactly as it was,
    // available to the admin packing flow.
    expect(prisma.shipment.updateMany).not.toHaveBeenCalled();
  });

  it('leaves the shipment status untouched — not FAILED', async () => {
    const { service } = build();
    const outcome = await service.createForOrder('o1');
    expect(outcome.status).toBe(ShipmentStatus.RATE_SELECTED);
  });

  it('books once a pickup time is present in metadata', async () => {
    const scheduled = order({}, { metadata: { paxel: { pickupDatetime: PICKUP } } });
    const { service, provider } = build(scheduled);
    const outcome = await service.createForOrder('o1');

    expect(outcome.ok).toBe(true);
    expect(provider.createShipment).toHaveBeenCalledTimes(1);
    expect(provider.createShipment.mock.calls[0][0].pickupAtIso).toBe(PICKUP);
  });

  it('does not gate a provider that has no pickup requirement', async () => {
    const { service, provider } = build();
    // JNE and friends: requiresPickupSchedule is undefined.
    (provider as { requiresPickupSchedule?: boolean }).requiresPickupSchedule = undefined;
    const outcome = await service.createForOrder('o1');

    expect(outcome.ok).toBe(true);
    expect(provider.createShipment).toHaveBeenCalledTimes(1);
  });
});

// ===================================================== the courier payload ====

describe('The payload handed to the courier', () => {
  it('carries the order value, payment method and per-item snapshot', async () => {
    const scheduled = order({}, { metadata: { paxel: { pickupDatetime: PICKUP } } });
    const { service, provider } = build(scheduled);
    await service.createForOrder('o1');

    const input = provider.createShipment.mock.calls[0][0];
    expect(input.invoiceValue).toBe(250000);
    expect(input.paymentMethod).toBe('BANK_TRANSFER');
    expect(input.items).toEqual([
      {
        code: 'SKU-1',
        name: 'Bakso',
        category: 'Makanan',
        quantity: 2,
        unitPrice: 45000,
        weightGram: 450,
        lengthCm: 20,
        widthCm: 15,
        heightCm: 10,
        isFragile: false,
      },
    ]);
  });

  it('carries region names for both endpoints', async () => {
    const scheduled = order({}, { metadata: { paxel: { pickupDatetime: PICKUP } } });
    const { service, provider } = build(scheduled);
    await service.createForOrder('o1');

    const input = provider.createShipment.mock.calls[0][0];
    expect(input.origin).toMatchObject({ city: 'Kota Bandung', district: 'Coblong', village: 'Dago', addressDetail: 'Jl. Outlet No.1' });
    expect(input.destination).toMatchObject({ city: 'Kota Bandung', district: 'Sukajadi', village: 'Pasteur', note: 'pagar hijau' });
  });

  it('passes a null snapshot through untouched so the provider can refuse it', async () => {
    const unmeasured = order({}, { metadata: { paxel: { pickupDatetime: PICKUP } } });
    unmeasured.items[0].weightGram = null as unknown as number;
    const { service, provider } = build(unmeasured);
    await service.createForOrder('o1');

    expect(provider.createShipment.mock.calls[0][0].items[0].weightGram).toBeNull();
  });

  it('does not overwrite Shipment.cost with anything from the provider', async () => {
    const scheduled = order({}, { metadata: { paxel: { pickupDatetime: PICKUP } } });
    const { service, tx } = build(scheduled);
    await service.createForOrder('o1');

    const persisted = tx.shipment.update.mock.calls[0][0].data;
    expect(persisted).not.toHaveProperty('cost');
    expect(persisted).toMatchObject({ trackingNumber: 'AWB-1', providerShipmentId: 'AWB-1', status: ShipmentStatus.CREATED });
    // The provider's shipping_cost survives only inside the snapshot.
    expect(JSON.stringify(persisted.providerPayload)).toContain('30000');
  });
});

// ================================================== the admin packing action ==

describe('prepareForOrder — the admin packing action', () => {
  it('persists the chosen pickup time, then books', async () => {
    const { service, prisma, provider } = build(order({}, { metadata: { paxel: { pickupDatetime: PICKUP } } }));
    prisma.shipment.findUnique.mockResolvedValue({ id: 'sh1', metadata: null, trackingNumber: null });

    const outcome = await service.prepareForOrder('o1', { pickupAtIso: PICKUP, service: 'PAXEL_SAMEDAY' });

    const written = prisma.shipment.update.mock.calls[0][0].data;
    expect(readPickupDatetime(written.metadata)).toBe(PICKUP);
    expect(written.service).toBe('PAXEL_SAMEDAY');
    expect(outcome.ok).toBe(true);
    expect(provider.createShipment).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid pickup time without touching the shipment', async () => {
    const { service, prisma } = build();
    const outcome = await service.prepareForOrder('o1', { pickupAtIso: 'not-a-date' });

    expect(outcome.ok).toBe(false);
    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });

  it('never rebooks an order that already has a tracking number', async () => {
    const { service, prisma, provider } = build();
    prisma.shipment.findUnique.mockResolvedValue({ id: 'sh1', metadata: null, trackingNumber: 'AWB-EXISTING', status: ShipmentStatus.CREATED });

    const outcome = await service.prepareForOrder('o1', { pickupAtIso: PICKUP });

    expect(outcome).toMatchObject({ ok: true, trackingNumber: 'AWB-EXISTING' });
    expect(provider.createShipment).not.toHaveBeenCalled();
    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });
});

// ================================================================ concurrency ==

describe('Concurrency — the claim still admits exactly one booking', () => {
  it('the caller that loses the claim never reaches the courier', async () => {
    const scheduled = order({}, { metadata: { paxel: { pickupDatetime: PICKUP } } });
    const { service, provider, prisma } = build(scheduled, { claimCount: 0 });
    prisma.shipment.findUnique.mockResolvedValue({ id: 'sh1', status: ShipmentStatus.PENDING, trackingNumber: null });

    const outcome = await service.createForOrder('o1');

    expect(outcome).toMatchObject({ ok: false, error: BOOKING_IN_PROGRESS });
    expect(provider.createShipment).not.toHaveBeenCalled();
  });

  it('the loser gets idempotent success when the winner already booked', async () => {
    const scheduled = order({}, { metadata: { paxel: { pickupDatetime: PICKUP } } });
    const { service, provider, prisma } = build(scheduled, { claimCount: 0 });
    prisma.shipment.findUnique.mockResolvedValue({ id: 'sh1', status: ShipmentStatus.CREATED, trackingNumber: 'AWB-WINNER' });

    const outcome = await service.createForOrder('o1');

    expect(outcome).toMatchObject({ ok: true, trackingNumber: 'AWB-WINNER' });
    expect(provider.createShipment).not.toHaveBeenCalled();
  });

  it('an already-booked shipment short-circuits before any claim or courier call', async () => {
    const booked = order({}, { trackingNumber: 'AWB-DONE', status: ShipmentStatus.CREATED });
    const { service, provider, prisma } = build(booked);

    const outcome = await service.createForOrder('o1');

    expect(outcome).toMatchObject({ ok: true, trackingNumber: 'AWB-DONE' });
    expect(prisma.shipment.updateMany).not.toHaveBeenCalled();
    expect(provider.createShipment).not.toHaveBeenCalled();
  });
});

// ==================================================== metadata does not clash ==

describe('Shipment metadata', () => {
  it('merges a pickup time into existing metadata instead of replacing it', () => {
    const existing = { error: 'previous failure', failedAt: '2026-08-01T00:00:00.000Z' };
    const merged = withPickupDatetime(existing, PICKUP);

    expect(merged).toMatchObject({ error: 'previous failure', paxel: { pickupDatetime: PICKUP } });
  });

  it('reads nothing from legacy or malformed metadata without throwing', () => {
    expect(readPickupDatetime(null)).toBeUndefined();
    expect(readPickupDatetime({ error: 'x' })).toBeUndefined();
    expect(readPickupDatetime([1, 2] as never)).toBeUndefined();
    expect(readPickupDatetime({ paxel: { pickupDatetime: '   ' } })).toBeUndefined();
  });
});
