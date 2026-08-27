import { ConflictException, NotFoundException } from '@nestjs/common';
import { ShipmentStatus } from '@prisma/client';
import { ShipmentService } from '../../src/modules/shipment/shipment.service';
import { trackingCacheKey } from '../../src/modules/shipment/shipment-sync.service';
import { JneShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/jne-shipment.provider';
import { mapAuditRoute } from '../../src/infrastructure/audit/audit-route.map';

/**
 * PAXELBOX-36. Both providers have implemented `cancelShipment` since the
 * shipment module was written and nothing ever called it — which is why
 * `deleteShipment` refuses a booked shipment, and why an operator's only
 * recourse was to hand-edit the status while the parcel stayed live at the
 * courier. This is that missing call.
 *
 * The ordering is the whole point: the courier goes first, and the local row is
 * touched only once it accepted. A row reading CANCELLED beside a parcel that is
 * still moving is precisely the state this endpoint exists to prevent.
 *
 * Deliberately undecided here (PAXELBOX-35): Order.status, OrderEvent and
 * customer notification. Those are pinned as "does not happen" so the decision
 * stays open rather than being made by accident.
 */

const AWB = 'CO.EMSULAR-20260826-1-F73PJC';

function shipmentRow(over: Record<string, unknown> = {}) {
  return {
    id: 'sh1',
    orderId: 'o1',
    provider: 'paxel',
    service: 'PAXEL_INSTANT',
    status: ShipmentStatus.CREATED,
    cost: 44000,
    trackingNumber: AWB,
    providerShipmentId: AWB,
    ...over,
  };
}

function build(row: Record<string, unknown> | null, opts: { cancelError?: Error; providers?: string[] } = {}) {
  const cancelShipment = jest.fn(async () => {
    if (opts.cancelError) throw opts.cancelError;
  });
  const registered = new Map(
    (opts.providers ?? ['paxel', 'jne']).map((name) => [name, { name, cancelShipment }]),
  );
  const prisma = {
    shipment: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...row, ...data })),
    },
    order: { update: jest.fn(), updateMany: jest.fn() },
    orderEvent: { create: jest.fn() },
    shipmentHistory: { create: jest.fn() },
    notificationOutbox: { create: jest.fn() },
  };
  const cache = { del: jest.fn().mockResolvedValue(undefined) };
  const factory = { get: jest.fn((n: string) => registered.get(n)), getAll: () => [...registered.values()] };
  const service = new ShipmentService(prisma as never, factory as never, cache as never);
  return { service, prisma, cache, cancelShipment, factory };
}

// ------------------------------------------------------------------ 1,2,3,5

describe('the courier is asked to cancel, using its own persisted handle', () => {
  it('calls Paxel with the persisted providerShipmentId', async () => {
    const { service, cancelShipment } = build(shipmentRow());

    await service.cancelForShipment('sh1');

    expect(cancelShipment).toHaveBeenCalledWith(AWB);
  });

  it('calls JNE with the persisted providerShipmentId', async () => {
    const { service, cancelShipment } = build(
      shipmentRow({ provider: 'jne', trackingNumber: 'CNOTE-1', providerShipmentId: 'CNOTE-1' }),
    );

    await service.cancelForShipment('sh1');

    expect(cancelShipment).toHaveBeenCalledWith('CNOTE-1');
  });

  it('resolves the provider from the shipment row, not from the caller', async () => {
    const { service, factory } = build(shipmentRow({ provider: 'jne', providerShipmentId: 'CNOTE-1' }));

    await service.cancelForShipment('sh1');

    expect(factory.get).toHaveBeenCalledWith('jne');
  });

  it('rejects a missing shipment', async () => {
    const { service } = build(null);

    await expect(service.cancelForShipment('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a shipment with no courier booking', async () => {
    const { service, cancelShipment } = build(shipmentRow({ providerShipmentId: null, trackingNumber: null }));

    await expect(service.cancelForShipment('sh1')).rejects.toBeInstanceOf(ConflictException);
    expect(cancelShipment).not.toHaveBeenCalled();
  });

  it('rejects a shipment whose provider is not registered', async () => {
    const { service, cancelShipment } = build(shipmentRow({ provider: 'gosend' }), { providers: ['paxel'] });

    await expect(service.cancelForShipment('sh1')).rejects.toThrow(/No provider registered for "gosend"/);
    expect(cancelShipment).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ 6, 18

describe('already cancelled is an idempotent no-op', () => {
  it('makes no courier call and writes nothing', async () => {
    const { service, cancelShipment, prisma } = build(shipmentRow({ status: ShipmentStatus.CANCELLED }));

    const out = await service.cancelForShipment('sh1');

    expect(cancelShipment).not.toHaveBeenCalled();
    expect(prisma.shipment.update).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, status: ShipmentStatus.CANCELLED });
  });
});

describe('the caller cannot choose what gets cancelled', () => {
  it('takes only a shipment id — the courier handle comes from the row', async () => {
    // One parameter, and it addresses OUR row; there is no seam through which a
    // request body could point the cancellation at someone else's parcel.
    expect(ShipmentService.prototype.cancelForShipment.length).toBe(1);

    const { service, cancelShipment } = build(shipmentRow({ providerShipmentId: 'PERSISTED-ONLY' }));
    await service.cancelForShipment('sh1');

    expect(cancelShipment).toHaveBeenCalledWith('PERSISTED-ONLY');
  });
});

// ------------------------------------------------------------- 8, 9, 10

describe('a refused cancellation is never recorded as one', () => {
  it('leaves the shipment untouched when the courier rejects it', async () => {
    const { service, prisma } = build(shipmentRow(), { cancelError: new Error('Paxel 409 already picked up') });

    await expect(service.cancelForShipment('sh1')).rejects.toThrow('Paxel 409 already picked up');

    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });

  it('does not invalidate the cache as though something had changed', async () => {
    const { service, cache } = build(shipmentRow(), { cancelError: new Error('Paxel 500') });

    await expect(service.cancelForShipment('sh1')).rejects.toThrow();

    expect(cache.del).not.toHaveBeenCalled();
  });

  it('creates no notification and touches no order on failure', async () => {
    const { service, prisma } = build(shipmentRow(), { cancelError: new Error('boom') });

    await expect(service.cancelForShipment('sh1')).rejects.toThrow();

    expect(prisma.notificationOutbox.create).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.orderEvent.create).not.toHaveBeenCalled();
  });

  it('propagates the provider error rather than swallowing it', async () => {
    const { service } = build(shipmentRow(), { cancelError: new Error('transient: gateway timeout') });

    // The endpoint must fail loudly; a silent success here would be the exact
    // orphaned-booking bug this phase set out to remove.
    await expect(service.cancelForShipment('sh1')).rejects.toThrow(/gateway timeout/);
  });
});

// ---------------------------------------------------------- 11,12,13,14,15

describe('after the courier accepts', () => {
  it('records CANCELLED locally', async () => {
    const { service, prisma } = build(shipmentRow());

    const out = await service.cancelForShipment('sh1');

    expect(prisma.shipment.update).toHaveBeenCalledWith({
      where: { id: 'sh1' },
      data: { status: ShipmentStatus.CANCELLED },
    });
    expect(out).toMatchObject({ ok: true, status: ShipmentStatus.CANCELLED });
  });

  it('writes the local row only AFTER the courier call', async () => {
    const order: string[] = [];
    const { service, prisma, cancelShipment } = build(shipmentRow());
    cancelShipment.mockImplementation(async () => void order.push('courier'));
    prisma.shipment.update.mockImplementation(async () => {
      order.push('db');
      return shipmentRow({ status: ShipmentStatus.CANCELLED });
    });

    await service.cancelForShipment('sh1');

    expect(order).toEqual(['courier', 'db']);
  });

  it('does NOT change Order.status or write an OrderEvent', async () => {
    // PAXELBOX-35 product decision, deliberately left open.
    const { service, prisma } = build(shipmentRow());

    await service.cancelForShipment('sh1');

    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.orderEvent.create).not.toHaveBeenCalled();
  });

  it('creates no customer notification', async () => {
    const { service, prisma } = build(shipmentRow());

    await service.cancelForShipment('sh1');

    expect(prisma.notificationOutbox.create).not.toHaveBeenCalled();
  });

  it('writes no ShipmentHistory — that table is provider tracking history', async () => {
    const { service, prisma } = build(shipmentRow());

    await service.cancelForShipment('sh1');

    expect(prisma.shipmentHistory.create).not.toHaveBeenCalled();
  });

  it('invalidates the tracking cache using the shared key builder', async () => {
    const { service, cache } = build(shipmentRow());

    await service.cancelForShipment('sh1');

    expect(cache.del).toHaveBeenCalledWith(trackingCacheKey('paxel', AWB));
  });

  it('a cache failure does not make a successful cancellation look failed', async () => {
    const { service, cache } = build(shipmentRow());
    cache.del.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.cancelForShipment('sh1')).resolves.toMatchObject({
      ok: true,
      status: ShipmentStatus.CANCELLED,
    });
  });

  it('works with no cache injected at all', async () => {
    const prisma = {
      shipment: {
        findUnique: jest.fn().mockResolvedValue(shipmentRow()),
        update: jest.fn().mockResolvedValue(shipmentRow({ status: ShipmentStatus.CANCELLED })),
      },
    };
    const provider = { name: 'paxel', cancelShipment: jest.fn().mockResolvedValue(undefined) };
    const service = new ShipmentService(prisma as never, { get: () => provider } as never);

    await expect(service.cancelForShipment('sh1')).resolves.toMatchObject({ ok: true });
  });
});

// -------------------------------------------------------------------- 17

describe('the action is audited by the existing interceptor', () => {
  it('POST /admin/shipments/:id/cancel maps to a Shipment audit record', async () => {
    // No explicit AuditTrail write is added: the global interceptor's generic
    // /admin fallback already covers this route, and Shipment is a known entity
    // delegate so before/after are snapshotted (PAXELBOX-34).
    expect(mapAuditRoute('POST', '/api/v1/admin/shipments/sh1/cancel')).toMatchObject({
      entity: 'Shipment',
    });
  });
});

// ---------------------------------------------------- 15: JNE transport

describe('JNE cancel transport (mocked HTTP — never a live call)', () => {
  function jne() {
    const calls: { url: string; init: { method?: string; body?: unknown } }[] = [];
    // The provider takes the whole ShippingConfig and reads `.jne` from it.
    const provider = new JneShipmentProvider({
      jne: { baseUrl: 'https://jne.test', username: 'u', apiKey: 'k', timeoutMs: 1000, maxRetry: 1, enabled: true },
    } as never);
    (provider as unknown as { http: unknown }).http = async (url: string, init: { method?: string; body?: unknown }) => {
      calls.push({ url, init });
      return { status: 200, text: async () => JSON.stringify({ status: 'success' }) };
    };
    return { provider, calls };
  }

  it('POSTs the cnote to the cancel path as form-encoded credentials', async () => {
    const { provider, calls } = jne();

    await provider.cancelShipment('CNOTE-1');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://jne.test/tracing/api/cancelcnote');
    expect(calls[0].init.method).toBe('POST');
    expect(String(calls[0].init.body)).toContain('cnote_no=CNOTE-1');
  });
});
