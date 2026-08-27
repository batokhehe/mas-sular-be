import { ShipmentStatus, OrderStatus } from '@prisma/client';
import { ShipmentSyncService } from '../../src/modules/shipment/shipment-sync.service';
import { loadShipmentTrackingConfig } from '../../src/modules/shipment/shipment-tracking.config';

/**
 * PAXELBOX-27: a RESPONSE cache around the courier tracking call.
 *
 * It is not a polling cooldown. The worker keeps its interval and every tick
 * still runs map → status compare → CAS → history → order → notify. Within the
 * TTL it simply reuses the courier's last raw answer for that airwaybill rather
 * than asking again, so the cache changes how often the courier is called and
 * nothing about what the system concludes.
 */

const AWB = 'CO.EMSULAR-20260826-1-F73PJC';

function shipmentRow(over: { provider?: string; trackingNumber?: string; status?: ShipmentStatus } = {}) {
  return {
    id: 'sh1',
    provider: over.provider ?? 'paxel',
    service: 'PAXEL_INSTANT',
    status: over.status ?? ShipmentStatus.CREATED,
    trackingNumber: over.trackingNumber ?? AWB,
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

/** A cache that behaves like the real one: set(key, value, ttlMs), get(key). */
function fakeCache() {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    get: jest.fn(async (key: string) => store.get(key)),
    set: jest.fn(async (key: string, value: unknown, ttl?: number) => {
      store.set(key, value);
      if (ttl !== undefined) ttls.set(key, ttl);
    }),
  };
}

function build(
  rows: ReturnType<typeof shipmentRow>[],
  opts: { cache?: ReturnType<typeof fakeCache>; providerError?: Error; config?: { cacheTtlMs: number } } = {},
) {
  const calls: string[] = [];
  const provider = {
    name: 'paxel',
    trackShipmentRaw: jest.fn(async (awb: string) => {
      calls.push(awb);
      if (opts.providerError) throw opts.providerError;
      return { providerStatus: 'DELIVERED', rawPayload: { awb, detail: 'live' } };
    }),
  };
  const jne = {
    name: 'jne',
    trackShipmentRaw: jest.fn(async (awb: string) => {
      calls.push('jne:' + awb);
      return { providerStatus: 'DELIVERED', rawPayload: { awb, detail: 'jne-live' } };
    }),
  };
  const tx = {
    shipment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
    get: (name: string) => (name === 'jne' ? jne : name === 'paxel' ? provider : undefined),
    getAll: () => [provider, jne],
  };
  const mapper = {
    map: jest.fn(() => ({ mapped: ShipmentStatus.DELIVERED, known: true })),
    toOrderStatus: () => OrderStatus.DELIVERED,
    label: () => 'Delivered',
    shouldNotify: () => true,
  };
  const service = new ShipmentSyncService(
    prisma as never,
    factory as never,
    mapper as never,
    opts.cache as never,
    opts.config as never,
  );
  return { service, provider, jne, calls, tx, mapper };
}

describe('cache MISS', () => {
  it('calls the courier once and stores the raw response', async () => {
    const cache = fakeCache();
    const { service, calls } = build([shipmentRow()], { cache });

    await service.syncAll();

    expect(calls).toEqual([AWB]);
    expect(cache.set).toHaveBeenCalledTimes(1);
    // The RAW provider response is what is stored — not a mapped status.
    expect(cache.set.mock.calls[0][1]).toEqual({
      providerStatus: 'DELIVERED',
      rawPayload: { awb: AWB, detail: 'live' },
    });
  });

  it('stores it under provider + airwaybill', async () => {
    const cache = fakeCache();
    const { service } = build([shipmentRow()], { cache });

    await service.syncAll();

    expect(cache.set.mock.calls[0][0]).toBe(`shipment:tracking:paxel:${AWB}`);
  });

  it('uses a 2-hour TTL by default', async () => {
    const cache = fakeCache();
    const { service } = build([shipmentRow()], { cache });

    await service.syncAll();

    expect(cache.set.mock.calls[0][2]).toBe(7_200_000);
    expect(loadShipmentTrackingConfig({} as NodeJS.ProcessEnv).cacheTtlMs).toBe(7_200_000);
  });

  it('honours a configured TTL', async () => {
    const cache = fakeCache();
    const { service } = build([shipmentRow()], { cache, config: { cacheTtlMs: 60_000 } });

    await service.syncAll();

    expect(cache.set.mock.calls[0][2]).toBe(60_000);
  });
});

describe('cache HIT', () => {
  it('does NOT call the courier', async () => {
    const cache = fakeCache();
    cache.store.set(`shipment:tracking:paxel:${AWB}`, {
      providerStatus: 'DELIVERED',
      rawPayload: { awb: AWB, detail: 'cached' },
    });
    const { service, calls } = build([shipmentRow()], { cache });

    await service.syncAll();

    expect(calls).toEqual([]);
  });

  it('still runs the mapper and the full transition pipeline', async () => {
    const cache = fakeCache();
    cache.store.set(`shipment:tracking:paxel:${AWB}`, {
      providerStatus: 'DELIVERED',
      rawPayload: { awb: AWB, detail: 'cached' },
    });
    const { service, tx, mapper, calls } = build([shipmentRow()], { cache });

    const changed = await service.syncAll();

    expect(calls).toEqual([]);
    expect(mapper.map).toHaveBeenCalledWith('paxel', 'DELIVERED');
    // PAXELBOX-25 CAS, then history, order flip and notification — unchanged.
    expect(tx.shipment.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.shipmentHistory.create).toHaveBeenCalledTimes(1);
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.notificationOutbox.create).toHaveBeenCalledTimes(1);
    expect(changed).toBe(1);
  });

  it('persists the CACHED raw payload, not a live one', async () => {
    const cache = fakeCache();
    cache.store.set(`shipment:tracking:paxel:${AWB}`, {
      providerStatus: 'DELIVERED',
      rawPayload: { awb: AWB, detail: 'cached' },
    });
    const { service, tx } = build([shipmentRow()], { cache });

    await service.syncAll();

    expect(tx.shipment.updateMany.mock.calls[0][0].data.providerPayload).toMatchObject({ detail: 'cached' });
  });

  it('a second tick within the TTL calls the courier exactly once in total', async () => {
    const cache = fakeCache();
    const { service, calls } = build([shipmentRow()], { cache });

    await service.syncAll();
    await service.syncAll();

    expect(calls).toEqual([AWB]);
  });
});

describe('errors are never cached', () => {
  it('stores nothing when the courier fails', async () => {
    const cache = fakeCache();
    const { service } = build([shipmentRow()], { cache, providerError: new Error('paxel 503') });

    await service.syncAll();

    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.store.size).toBe(0);
  });

  it('keeps per-shipment isolation and retries on the next tick', async () => {
    const cache = fakeCache();
    const { service, calls } = build([shipmentRow()], { cache, providerError: new Error('paxel 503') });

    await expect(service.syncAll()).resolves.toBe(0);
    await service.syncAll();

    // Nothing was cached, so the second tick asks again rather than reusing a failure.
    expect(calls).toEqual([AWB, AWB]);
  });
});

describe('cache key identity', () => {
  it('a different airwaybill is a different key', async () => {
    const cache = fakeCache();
    const { service } = build(
      [shipmentRow({ trackingNumber: 'AWB-A' }), shipmentRow({ trackingNumber: 'AWB-B' })],
      { cache },
    );

    await service.syncAll();

    expect([...cache.store.keys()]).toEqual([
      'shipment:tracking:paxel:AWB-A',
      'shipment:tracking:paxel:AWB-B',
    ]);
  });

  it('the same airwaybill on two couriers does not collide', async () => {
    const cache = fakeCache();
    const { service, calls } = build(
      [shipmentRow({ provider: 'paxel', trackingNumber: 'SHARED' }), shipmentRow({ provider: 'jne', trackingNumber: 'SHARED' })],
      { cache },
    );

    await service.syncAll();

    expect([...cache.store.keys()]).toEqual([
      'shipment:tracking:paxel:SHARED',
      'shipment:tracking:jne:SHARED',
    ]);
    // Both couriers were genuinely asked — no cross-provider reuse.
    expect(calls).toEqual(['SHARED', 'jne:SHARED']);
  });
});

describe('the cache is an enhancement, never a dependency', () => {
  it('works with no cache injected at all', async () => {
    const { service, calls, tx } = build([shipmentRow()]);

    const changed = await service.syncAll();

    expect(calls).toEqual([AWB]);
    expect(tx.shipmentHistory.create).toHaveBeenCalledTimes(1);
    expect(changed).toBe(1);
  });

  it('falls back to the courier when the cache read throws', async () => {
    const cache = fakeCache();
    cache.get.mockRejectedValueOnce(new Error('redis down'));
    const { service, calls } = build([shipmentRow()], { cache });

    await expect(service.syncAll()).resolves.toBe(1);
    expect(calls).toEqual([AWB]);
  });

  it('still returns a live result when the cache write throws', async () => {
    const cache = fakeCache();
    cache.set.mockRejectedValueOnce(new Error('redis down'));
    const { service, tx } = build([shipmentRow()], { cache });

    await expect(service.syncAll()).resolves.toBe(1);
    expect(tx.shipmentHistory.create).toHaveBeenCalledTimes(1);
  });
});
