import { ConflictException } from '@nestjs/common';
import { AdminService } from '../../src/modules/admin/admin.service';
import { trackingCacheKey } from '../../src/modules/shipment/shipment-sync.service';

/**
 * PAXELBOX-33. Two evidence-backed corrections to the manual shipment edit.
 *
 * 1. The airwaybill is no longer replaceable once one exists. Every other
 *    writer of trackingNumber copies it from the courier's own CREATE response;
 *    this PATCH was the only place an arbitrary value could be written, and a
 *    replacement silently detaches the record from the real parcel.
 *
 * 2. The cached courier response for that parcel is dropped on edit. A manual
 *    status change can land on a status that is still polled, and PAXELBOX-27
 *    keeps the courier's last answer reusable for two hours — long enough for
 *    the next tick to overwrite the edit using data older than the edit itself.
 *
 * What this phase deliberately does NOT do (PAXELBOX-32 found no evidence for
 * any of it): synchronize Order.status, emit a customer notification, restrict
 * which ShipmentStatus values may be set, or write a ShipmentHistory row — the
 * history schema cannot express "previous status" or "changed by an admin"
 * without misusing providerStatus.
 */

const AWB = 'CO.EMSULAR-20260826-1-F73PJC';

function build(existing: Record<string, unknown> = {}) {
  const shipment = {
    id: 'sh1',
    provider: 'paxel',
    service: 'PAXEL_INSTANT',
    cost: 44000,
    status: 'CREATED',
    trackingNumber: null,
    providerShipmentId: null,
    trackingUrl: null,
    metadata: null,
    order: { id: 'o1', orderNumber: 'BMS-1' },
    ...existing,
  };
  const prisma = {
    shipment: {
      findUnique: jest.fn().mockResolvedValue(shipment),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...shipment, ...data })),
      delete: jest.fn().mockResolvedValue(shipment),
    },
    order: { update: jest.fn(), updateMany: jest.fn() },
    orderEvent: { create: jest.fn() },
    shipmentHistory: { create: jest.fn() },
    notificationOutbox: { create: jest.fn() },
  };
  const cache = { del: jest.fn().mockResolvedValue(undefined), get: jest.fn(), set: jest.fn() };
  const service = new AdminService(
    prisma as never, {} as never, undefined, undefined, undefined, cache as never,
  );
  return { service, prisma, cache, shipment };
}

const BOOKED = { trackingNumber: AWB, providerShipmentId: AWB };

// ------------------------------------------------------------------- 1, 2

describe('the airwaybill cannot be replaced once booked', () => {
  it('refuses a DIFFERENT trackingNumber', async () => {
    const { service, prisma } = build(BOOKED);

    await expect(
      service.updateShipment('sh1', { trackingNumber: 'CO.SOMETHING-ELSE' } as never),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });

  it('names the booked airwaybill in the error', async () => {
    const { service } = build(BOOKED);

    await expect(
      service.updateShipment('sh1', { trackingNumber: 'OTHER' } as never),
    ).rejects.toThrow(/already booked.*CO\.EMSULAR-20260826-1-F73PJC/s);
  });

  it('still accepts the SAME trackingNumber resubmitted by the form', async () => {
    // The edit form posts every field, so mere presence must not be refused.
    const { service, prisma } = build(BOOKED);

    await service.updateShipment('sh1', {
      provider: 'paxel', service: 'PAXEL_INSTANT', cost: 44000, status: 'IN_TRANSIT', trackingNumber: AWB,
    } as never);

    expect(prisma.shipment.update).toHaveBeenCalled();
  });

  it('guards on providerShipmentId alone, when the AWB field is not yet set', async () => {
    const { service, prisma } = build({ trackingNumber: null, providerShipmentId: AWB });

    await expect(
      service.updateShipment('sh1', { trackingNumber: 'INVENTED' } as never),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });

  it('an UNBOOKED draft may still have its trackingNumber set', async () => {
    // Manually recording a courier-issued number on a draft is legitimate.
    const { service, prisma } = build({ trackingNumber: null, providerShipmentId: null });

    await service.updateShipment('sh1', { trackingNumber: 'MANUAL-1' } as never);

    expect(prisma.shipment.update.mock.calls[0][0].data).toMatchObject({ trackingNumber: 'MANUAL-1' });
  });
});

// ------------------------------------------------------------------ 3, 4, 5

describe('the PAXELBOX-21 guards and the legitimate edit workflow are intact', () => {
  it('still refuses a provider change after AWB', async () => {
    const { service } = build(BOOKED);
    await expect(service.updateShipment('sh1', { provider: 'jne' } as never)).rejects.toBeInstanceOf(ConflictException);
  });

  it('still refuses a service change after AWB', async () => {
    const { service } = build(BOOKED);
    await expect(service.updateShipment('sh1', { service: 'PAXEL_SAMEDAY' } as never)).rejects.toBeInstanceOf(ConflictException);
  });

  it('still allows a cost correction on a booked shipment', async () => {
    const { service, prisma } = build(BOOKED);

    await service.updateShipment('sh1', { cost: 50000 } as never);

    expect(prisma.shipment.update.mock.calls[0][0].data).toMatchObject({ cost: 50000 });
  });

  it('still allows a trackingUrl correction on a booked shipment', async () => {
    const { service, prisma } = build(BOOKED);

    await service.updateShipment('sh1', { trackingUrl: 'https://track.test/1' } as never);

    expect(prisma.shipment.update.mock.calls[0][0].data).toMatchObject({ trackingUrl: 'https://track.test/1' });
  });

  it('still deletes an unbooked draft but refuses a booked shipment', async () => {
    const draft = build({ trackingNumber: null, providerShipmentId: null });
    await draft.service.deleteShipment('sh1');
    expect(draft.prisma.shipment.delete).toHaveBeenCalled();

    const booked = build(BOOKED);
    await expect(booked.service.deleteShipment('sh1')).rejects.toBeInstanceOf(ConflictException);
    expect(booked.prisma.shipment.delete).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ 8, 9

describe('a manual edit stays confined to the shipment row', () => {
  it('does NOT change Order.status', async () => {
    // PAXELBOX-32 found no evidence that a manual edit means courier-confirmed
    // reality, so the order is deliberately left alone.
    const { service, prisma } = build(BOOKED);

    await service.updateShipment('sh1', { status: 'DELIVERED' } as never);

    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.orderEvent.create).not.toHaveBeenCalled();
  });

  it('does NOT create a NotificationOutbox row', async () => {
    const { service, prisma } = build(BOOKED);

    await service.updateShipment('sh1', { status: 'DELIVERED' } as never);

    expect(prisma.notificationOutbox.create).not.toHaveBeenCalled();
  });

  it('writes no ShipmentHistory — the schema cannot express a manual change', async () => {
    // Pinning the CURRENT, reported gap: ShipmentHistory has providerStatus /
    // mappedStatus / changedAt and no previousStatus or actor, so recording an
    // admin edit would mean writing admin data into a provider field.
    const { service, prisma } = build(BOOKED);

    await service.updateShipment('sh1', { status: 'DELIVERED' } as never);

    expect(prisma.shipmentHistory.create).not.toHaveBeenCalled();
  });

  it('accepts any ShipmentStatus — no transition matrix was invented', async () => {
    for (const status of ['PENDING', 'CREATED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED']) {
      const { service, prisma } = build(BOOKED);
      await service.updateShipment('sh1', { status } as never);
      expect(prisma.shipment.update.mock.calls[0][0].data).toMatchObject({ status });
    }
  });
});

// --------------------------------------------------------------------- 10

describe('the stale tracking response is dropped on edit', () => {
  it('invalidates exactly the key the sync service would read', async () => {
    const { service, cache } = build(BOOKED);

    await service.updateShipment('sh1', { status: 'IN_TRANSIT' } as never);

    expect(cache.del).toHaveBeenCalledWith(trackingCacheKey('paxel', AWB));
    expect(trackingCacheKey('paxel', AWB)).toBe(`shipment:tracking:paxel:${AWB}`);
  });

  it('does nothing for a draft with no airwaybill', async () => {
    const { service, cache } = build({ trackingNumber: null, providerShipmentId: null });

    await service.updateShipment('sh1', { cost: 1000 } as never);

    expect(cache.del).not.toHaveBeenCalled();
  });

  it('a cache fault never fails the edit', async () => {
    const { service, prisma, cache } = build(BOOKED);
    cache.del.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.updateShipment('sh1', { cost: 50000 } as never)).resolves.toBeDefined();

    expect(prisma.shipment.update).toHaveBeenCalled();
  });

  it('works with no cache injected at all', async () => {
    const prisma = {
      shipment: {
        findUnique: jest.fn().mockResolvedValue({ ...BOOKED, id: 'sh1', provider: 'paxel', service: 'S', cost: 1, status: 'CREATED', order: {} }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new AdminService(prisma as never, {} as never);

    await expect(service.updateShipment('sh1', { cost: 2 } as never)).resolves.toBeDefined();
  });

  it('is not invalidated when the edit is refused', async () => {
    const { service, cache } = build(BOOKED);

    await expect(service.updateShipment('sh1', { provider: 'jne' } as never)).rejects.toBeInstanceOf(ConflictException);

    expect(cache.del).not.toHaveBeenCalled();
  });
});
