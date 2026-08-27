import { ShipmentStatus, OrderStatus } from '@prisma/client';
import { ShipmentSyncService } from '../../src/modules/shipment/shipment-sync.service';

/**
 * PAXELBOX-24. `syncAll` used to skip a shipment whose provider is not in the
 * registry with a bare `continue`, sharing that line with the ordinary
 * "no airwaybill yet" skip.
 *
 * The two mean opposite things. No AWB is expected and temporary. An
 * unregistered provider is a data defect: nothing in this build can ever track
 * that courier, so the shipment leaves tracking permanently — and it did so
 * with no log, no history row and nothing an operator could see.
 *
 * These pin that it is now reported, that reporting it costs nothing in the
 * database, and that one bad row cannot stop the rest of the batch.
 */

function shipmentRow(over: { id?: string; provider?: string; trackingNumber?: string | null } = {}) {
  return {
    id: over.id ?? 'sh1',
    provider: over.provider ?? 'paxel',
    service: 'PAXEL_INSTANT',
    status: ShipmentStatus.IN_TRANSIT,
    trackingNumber: over.trackingNumber === undefined ? 'AWB-1' : over.trackingNumber,
    order: {
      id: 'o1',
      orderNumber: 'BMS-1',
      status: OrderStatus.SHIPPED,
      shippingService: 'PAXEL_INSTANT',
      shippingServiceName: 'Paxel Instant',
      user: { name: 'Budi', email: 'budi@test.com', phone: '628123' },
      address: { phone: '628123' },
    },
  };
}

function build(rows: ReturnType<typeof shipmentRow>[], registered: string[] = ['paxel', 'jne']) {
  const tracked: string[] = [];
  const providers = new Map(
    registered.map((name) => [
      name,
      {
        name,
        trackShipmentRaw: jest.fn(async (awb: string) => {
          tracked.push(awb);
          return { providerStatus: 'DELIVERED', rawPayload: {} };
        }),
      },
    ]),
  );
  const tx = {
    shipment: {
      update: jest.fn().mockResolvedValue({}),
      // The transition is CAS-claimed; count 1 = this run won it.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    shipmentHistory: { create: jest.fn().mockResolvedValue({}) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    shipment: { findMany: jest.fn().mockResolvedValue(rows) },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  const factory = {
    get: (name: string) => providers.get(name),
    getAll: () => [...providers.values()],
  };
  const mapper = {
    map: () => ({ mapped: ShipmentStatus.DELIVERED, known: true }),
    toOrderStatus: () => OrderStatus.DELIVERED,
    label: () => 'Delivered',
    shouldNotify: () => false,
  };
  const service = new ShipmentSyncService(prisma as never, factory as never, mapper as never);
  const errors: Record<string, unknown>[] = [];
  jest
    .spyOn((service as unknown as { logger: { error: (o: unknown) => void } }).logger, 'error')
    .mockImplementation((payload: unknown) => {
      errors.push(payload as Record<string, unknown>);
    });
  return { service, prisma, tx, tracked, errors };
}

describe('a registered provider still tracks normally', () => {
  it('resolves paxel and polls it', async () => {
    const { service, tracked } = build([shipmentRow({ provider: 'paxel' })]);

    await service.syncAll();

    expect(tracked).toEqual(['AWB-1']);
  });

  it('resolves jne and polls it', async () => {
    const { service, tracked } = build([shipmentRow({ provider: 'jne' })]);

    await service.syncAll();

    expect(tracked).toEqual(['AWB-1']);
  });
});

describe('an unregistered provider is reported, not swallowed', () => {
  it('logs an error naming the shipment, order, provider and AWB', async () => {
    const { service, errors } = build([shipmentRow({ provider: 'gosend' })]);

    await service.syncAll();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      event: 'shipment.provider_unknown',
      shipmentId: 'sh1',
      orderId: 'o1',
      orderNumber: 'BMS-1',
      provider: 'gosend',
      trackingNumber: 'AWB-1',
    });
    // Diagnosable: says what WAS available.
    expect(errors[0].registeredProviders).toEqual(['paxel', 'jne']);
  });

  it('writes nothing to the database when it reports the mismatch', async () => {
    const { service, prisma, tx } = build([shipmentRow({ provider: 'gosend' })]);

    await service.syncAll();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.shipment.updateMany).not.toHaveBeenCalled();
    expect(tx.shipmentHistory.create).not.toHaveBeenCalled();
  });

  it('counts as unchanged, so the worker reports honestly', async () => {
    const { service } = build([shipmentRow({ provider: 'gosend' })]);

    await expect(service.syncAll()).resolves.toBe(0);
  });
});

describe('one bad row does not stop the batch', () => {
  it('still tracks the healthy shipments alongside it', async () => {
    const { service, tracked, errors } = build([
      shipmentRow({ id: 'bad', provider: 'gosend', trackingNumber: 'AWB-BAD' }),
      shipmentRow({ id: 'good', provider: 'paxel', trackingNumber: 'AWB-GOOD' }),
    ]);

    const changed = await service.syncAll();

    expect(tracked).toEqual(['AWB-GOOD']);
    expect(errors.map((e) => e.shipmentId)).toEqual(['bad']);
    expect(changed).toBe(1);
  });
});

describe('the ordinary "not trackable yet" skip stays quiet', () => {
  it('does not report a registered provider that simply has no airwaybill', async () => {
    const { service, errors, tracked } = build([
      shipmentRow({ provider: 'paxel', trackingNumber: null }),
    ]);

    await service.syncAll();

    // Expected and temporary — not a defect, so nothing is logged as an error.
    expect(errors).toHaveLength(0);
    expect(tracked).toEqual([]);
  });
});

/**
 * PAXELBOX-25: the transition is claimed with a CAS on the status that was
 * read, so a second run that observed the same old status records nothing.
 *
 * Without it, two instances polling one shipment would each append a history
 * row and each enqueue a customer WhatsApp — contradicting the "notify exactly
 * once per transition" intent. The Order flip was already CAS-guarded; the
 * shipment write simply had not been given the same treatment.
 */
describe('a transition is applied exactly once', () => {
  function buildCas(claimCount: number) {
    const tx = {
      shipment: { updateMany: jest.fn().mockResolvedValue({ count: claimCount }) },
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      shipmentHistory: { create: jest.fn().mockResolvedValue({}) },
      notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
    };
    const provider = {
      name: 'paxel',
      trackShipmentRaw: jest.fn().mockResolvedValue({ providerStatus: 'DELIVERED', rawPayload: {} }),
    };
    const prisma = {
      shipment: { findMany: jest.fn().mockResolvedValue([shipmentRow({ provider: 'paxel' })]) },
      $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    };
    const factory = { get: () => provider, getAll: () => [provider] };
    const mapper = {
      map: () => ({ mapped: ShipmentStatus.DELIVERED, known: true }),
      toOrderStatus: () => OrderStatus.DELIVERED,
      label: () => 'Delivered',
      shouldNotify: () => true,
    };
    const service = new ShipmentSyncService(prisma as never, factory as never, mapper as never);
    return { service, tx };
  }

  it('records history, the order flip and one notification when it wins the claim', async () => {
    const { service, tx } = buildCas(1);

    await service.syncAll();

    expect(tx.shipment.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.shipmentHistory.create).toHaveBeenCalledTimes(1);
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.notificationOutbox.create).toHaveBeenCalledTimes(1);
  });

  it('records NOTHING further when another run already applied it', async () => {
    const { service, tx } = buildCas(0);

    await service.syncAll();

    expect(tx.shipment.updateMany).toHaveBeenCalledTimes(1);
    // No duplicate audit row, no duplicate order event, and crucially no
    // second WhatsApp to the customer.
    expect(tx.shipmentHistory.create).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.notificationOutbox.create).not.toHaveBeenCalled();
  });

  it('claims on the status that was read, not blindly by id', async () => {
    const { service, tx } = buildCas(1);

    await service.syncAll();

    expect(tx.shipment.updateMany.mock.calls[0][0].where).toMatchObject({
      id: 'sh1',
      status: ShipmentStatus.IN_TRANSIT,
    });
  });
});
