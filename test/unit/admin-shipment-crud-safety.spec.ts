import { ConflictException } from '@nestjs/common';
import { AdminService } from '../../src/modules/admin/admin.service';

/**
 * PAXELBOX-21. `PATCH /admin/shipments/:id` backs a real manual shipment-editing
 * screen, so it stays — but it used to let an operator re-point a shipment that
 * a courier had ALREADY accepted at a different provider or service.
 *
 * The parcel keeps moving under the original booking, and the customer was
 * priced for the original service, so the record would simply start describing
 * something nobody agreed to ship. That needs a rebooking, not an edit.
 *
 * The comparison is by VALUE because the edit form resubmits every field: a
 * guard on mere presence would make a booked shipment completely uneditable.
 */

function build(existing: Record<string, unknown>) {
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
  };
  const service = new AdminService(prisma as never, {} as never);
  return { service, prisma, shipment };
}

const BOOKED = { trackingNumber: 'CO.EMSULAR-1', providerShipmentId: 'CO.EMSULAR-1' };

describe('a booked shipment cannot be retargeted', () => {
  it('refuses a service change once an airwaybill exists', async () => {
    const { service, prisma } = build(BOOKED);

    await expect(
      service.updateShipment('sh1', { service: 'PAXEL_SAMEDAY' } as never),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });

  it('refuses a provider change once an airwaybill exists', async () => {
    const { service, prisma } = build(BOOKED);

    await expect(service.updateShipment('sh1', { provider: 'jne' } as never)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });

  it('names what was refused and the airwaybill involved', async () => {
    const { service } = build(BOOKED);

    await expect(
      service.updateShipment('sh1', { provider: 'jne', service: 'REG' } as never),
    ).rejects.toThrow(/provider or service.*CO\.EMSULAR-1/s);
  });

  it('guards on providerShipmentId even when trackingNumber is absent', async () => {
    const { service, prisma } = build({ trackingNumber: null, providerShipmentId: 'CO.EMSULAR-1' });

    await expect(service.updateShipment('sh1', { service: 'REG' } as never)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });
});

describe('the manual editing workflow still works', () => {
  it('allows editing cost/status/url on a booked shipment', async () => {
    const { service, prisma } = build(BOOKED);

    await service.updateShipment('sh1', { cost: 50000, trackingUrl: 'https://track.test/1' } as never);

    expect(prisma.shipment.update).toHaveBeenCalled();
    expect(prisma.shipment.update.mock.calls[0][0].data).toMatchObject({ cost: 50000 });
  });

  it('allows a booked shipment to be resubmitted with UNCHANGED provider/service', async () => {
    // Exactly what the edit form sends: every field, most of them untouched.
    const { service, prisma } = build(BOOKED);

    await service.updateShipment('sh1', {
      provider: 'paxel',
      service: 'PAXEL_INSTANT',
      cost: 44000,
      status: 'CREATED',
    } as never);

    expect(prisma.shipment.update).toHaveBeenCalled();
  });

  it('still allows provider/service edits BEFORE a booking exists', async () => {
    // An unbooked manual shipment is a draft; correcting it is legitimate.
    const { service, prisma } = build({ trackingNumber: null, providerShipmentId: null });

    await service.updateShipment('sh1', { provider: 'jne', service: 'REG' } as never);

    expect(prisma.shipment.update.mock.calls[0][0].data).toMatchObject({ provider: 'jne', service: 'REG' });
  });
});

describe('a booked shipment cannot be hard-deleted', () => {
  it('refuses to delete a shipment that has an airwaybill', async () => {
    const { service, prisma } = build(BOOKED);

    await expect(service.deleteShipment('sh1')).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.shipment.delete).not.toHaveBeenCalled();
  });

  it('refuses on providerShipmentId alone, even without a trackingNumber', async () => {
    const { service, prisma } = build({ trackingNumber: null, providerShipmentId: 'CO.EMSULAR-1' });

    await expect(service.deleteShipment('sh1')).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.shipment.delete).not.toHaveBeenCalled();
  });

  it('explains that the courier booking would outlive the record', async () => {
    const { service } = build(BOOKED);

    await expect(service.deleteShipment('sh1')).rejects.toThrow(/CO\.EMSULAR-1.*Cancel the booking/s);
  });

  it('still deletes an unbooked draft — the legitimate workflow', async () => {
    const { service, prisma } = build({ trackingNumber: null, providerShipmentId: null });

    await service.deleteShipment('sh1');

    expect(prisma.shipment.delete).toHaveBeenCalledWith({ where: { id: 'sh1' } });
  });
});
