import { OrderStatus, PaymentStatus, ShipmentStatus } from '@prisma/client';
import {
  AWAITING_MANUAL_FULFILMENT,
  ShipmentService,
} from '../../src/modules/shipment/shipment.service';
import { ShipmentSyncService, trackingCacheKey } from '../../src/modules/shipment/shipment-sync.service';
import { ShipmentReconciliationWorker } from '../../src/modules/shipment/shipment-reconciliation.worker';
import { JneShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/jne-shipment.provider';
import { PaxelShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/paxel-shipment.provider';

/**
 * PAXELBOX-38. JNE is quoted through the application but booked outside it: an
 * operator arranges the consignment and records the cnote by hand.
 *
 * The split is declared on the PROVIDER (`supportsAutomaticBooking = false`),
 * next to the existing `requiresPickupSchedule` marker, rather than behind a new
 * environment flag. It is a fact about the courier arrangement, not about the
 * environment — and `JNE_ENABLED` could not have expressed it anyway, because
 * quotation and fulfilment share that one flag.
 *
 * `createShipment` is deliberately KEPT on the provider: tracking and
 * cancellation beside it stay in use, and an unused-but-correct method is better
 * than an incomplete integration.
 */

const CNOTE = 'JNE-CNOTE-0001';

function orderRow(provider: string) {
  return {
    id: 'o1',
    orderNumber: 'BMS-1',
    shippingProvider: provider,
    outletId: 'out1',
    address: { postalCode: '40123' },
    shipment: {
      id: 'sh1',
      provider,
      service: provider === 'jne' ? 'REG' : 'PAXEL_INSTANT',
      status: ShipmentStatus.RATE_SELECTED,
      trackingNumber: null,
      metadata: null,
    },
    items: [],
  };
}

function bookingHarness(provider: string) {
  const createShipment = jest.fn();
  const providers: Record<string, unknown> = {
    jne: { name: 'jne', supportsAutomaticBooking: false, createShipment },
    paxel: { name: 'paxel', requiresPickupSchedule: true, createShipment },
  };
  const outlet = { id: 'out1', postalCode: '40111', address: 'Jl. Test' };
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(orderRow(provider)) },
    shipment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn(), update: jest.fn() },
    outlet: { findUnique: jest.fn().mockResolvedValue(outlet), findFirst: jest.fn().mockResolvedValue(outlet) },
    $transaction: jest.fn(),
  };
  const service = new ShipmentService(
    prisma as never,
    { get: (n: string) => providers[n] } as never,
  );
  return { service, prisma, createShipment };
}

// ------------------------------------------------------------ 8, 9, 10, 12

describe('the generic booking flow never books JNE', () => {
  it('returns "awaiting manual fulfilment" instead of calling JNE CREATE', async () => {
    const { service, createShipment } = bookingHarness('jne');

    const outcome = await service.createForOrder('o1');

    expect(outcome).toMatchObject({ ok: false, error: AWAITING_MANUAL_FULFILMENT });
    expect(createShipment).not.toHaveBeenCalled();
  });

  it('leaves the shipment row completely untouched — no claim, no FAILED', async () => {
    const { service, prisma } = bookingHarness('jne');

    await service.createForOrder('o1');

    // Refused BEFORE the CAS claim, so nothing was written and the row is still
    // exactly what the admin flow will pick up.
    expect(prisma.shipment.updateMany).not.toHaveBeenCalled();
    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });

  it('covers payment verification and admin retry too — they share this path', async () => {
    // createForOrderSafe wraps createForOrder; retry() wraps createForOrderSafe.
    const a = bookingHarness('jne');
    await expect(a.service.createForOrderSafe('o1')).resolves.toMatchObject({
      ok: false, error: AWAITING_MANUAL_FULFILMENT,
    });
    expect(a.createShipment).not.toHaveBeenCalled();

    const b = bookingHarness('jne');
    await expect(b.service.retry('o1')).resolves.toMatchObject({ ok: false, error: AWAITING_MANUAL_FULFILMENT });
    expect(b.createShipment).not.toHaveBeenCalled();
  });

  it('does NOT mark the shipment FAILED, so retry stays clean', async () => {
    const { service, prisma } = bookingHarness('jne');

    await service.createForOrderSafe('o1');

    // createForOrderSafe marks FAILED only on a thrown error; a manual-fulfilment
    // outcome is a normal return, not an exception.
    expect(prisma.shipment.updateMany).not.toHaveBeenCalled();
  });
});

describe('Paxel booking is unaffected', () => {
  it('is not short-circuited by the new marker', async () => {
    const { service, createShipment } = bookingHarness('paxel');

    const outcome = await service.createForOrder('o1');

    // Paxel gets past the marker and stops at its own pickup-schedule rule —
    // proving the manual-fulfilment check did not intercept it.
    expect(outcome.error).not.toBe(AWAITING_MANUAL_FULFILMENT);
    expect(createShipment).not.toHaveBeenCalled(); // stopped by requiresPickupSchedule
  });

  it('declares automatic booking (marker absent ⇒ enabled)', () => {
    const cfg = { jne: { enabled: true }, paxel: { enabled: true } } as never;
    const jne = new JneShipmentProvider(cfg) as unknown as Record<string, unknown>;
    const paxel = new PaxelShipmentProvider(cfg) as unknown as Record<string, unknown>;

    expect(jne.supportsAutomaticBooking).toBe(false);
    // Paxel does not declare the property at all — absence IS the default, so no
    // existing provider had to be edited to keep booking automatically.
    expect(paxel.supportsAutomaticBooking).toBeUndefined();
    expect(paxel.requiresPickupSchedule).toBe(true);
  });
});

// -------------------------------------------------------------------- 11

describe('reconciliation cannot book JNE either', () => {
  function worker(error: string) {
    const shipments = { createForOrderSafe: jest.fn().mockResolvedValue({ ok: false, status: 'RATE_SELECTED', error }) };
    const metrics = { setPending: jest.fn(), success: jest.fn(), failure: jest.fn() };
    const prisma = { shipment: { findMany: jest.fn().mockResolvedValue([{ orderId: 'o1' }]) } };
    const w = new ShipmentReconciliationWorker(
      prisma as never, shipments as never, metrics as never,
      { enabled: false, pollIntervalMs: 1, batchSize: 10, delayMs: 0, initialDelayMs: 0, healthLogIntervalMs: 1 } as never,
    );
    return { w, metrics, shipments };
  }

  it('skips a manual-fulfilment courier instead of counting it as a failure', async () => {
    const { w, metrics } = worker(AWAITING_MANUAL_FULFILMENT);

    const result = await w.reconcile();

    expect(result).toMatchObject({ booked: 0, failed: 0 });
    // Would otherwise alarm on every JNE order, forever.
    expect(metrics.failure).not.toHaveBeenCalled();
  });

  it('still counts a genuine booking failure', async () => {
    const { w, metrics } = worker('Paxel 500');

    const result = await w.reconcile();

    expect(result.failed).toBe(1);
    expect(metrics.failure).toHaveBeenCalledTimes(1);
  });
});

// -------------------------------------------------------- 14, 15, 16, 21-25

describe('the manual JNE flow: admin records the cnote, tracking picks it up', () => {
  function syncHarness(cached: boolean) {
    const trackShipmentRaw = jest.fn(async () => ({ providerStatus: 'ON_PROCESS', rawPayload: { detail: 'live' } }));
    const jne = { name: 'jne', trackShipmentRaw, supportsAutomaticBooking: false };
    const paxel = { name: 'paxel', trackShipmentRaw: jest.fn() };
    const store = new Map<string, unknown>();
    if (cached) store.set(trackingCacheKey('jne', CNOTE), { providerStatus: 'ON_PROCESS', rawPayload: { detail: 'cached' } });
    const cache = { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v) };
    const tx = {
      shipment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      orderEvent: { create: jest.fn() },
      shipmentHistory: { create: jest.fn() },
      notificationOutbox: { create: jest.fn() },
    };
    const prisma = {
      shipment: {
        findMany: jest.fn().mockResolvedValue([{
          // Exactly what the admin manual flow persists: provider jne, a cnote
          // typed in by hand, and no providerShipmentId from any API.
          id: 'sh1', provider: 'jne', service: 'REG', status: ShipmentStatus.CREATED, trackingNumber: CNOTE,
          order: {
            id: 'o1', orderNumber: 'BMS-1', status: OrderStatus.SHIPPED,
            shippingService: 'REG', shippingServiceName: 'JNE Reguler',
            user: { name: 'Budi', email: 'b@t.com', phone: '628123' }, address: { phone: '628123' },
          },
        }]),
      },
      $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    };
    const mapper = {
      map: jest.fn(() => ({ mapped: ShipmentStatus.IN_TRANSIT, known: true })),
      toOrderStatus: () => OrderStatus.DELIVERING,
      label: () => 'Dalam perjalanan',
      shouldNotify: () => true,
    };
    const sync = new ShipmentSyncService(
      prisma as never,
      { get: (n: string) => (n === 'jne' ? jne : paxel), getAll: () => [jne, paxel] } as never,
      mapper as never, cache as never, undefined,
    );
    return { sync, tx, trackShipmentRaw, mapper, store };
  }

  it('tracks a manually entered cnote through the jne provider', async () => {
    const { sync, trackShipmentRaw, mapper } = syncHarness(false);

    await expect(sync.syncAll()).resolves.toBe(1);

    expect(trackShipmentRaw).toHaveBeenCalledWith(CNOTE);
    expect(mapper.map).toHaveBeenCalledWith('jne', 'ON_PROCESS');
  });

  it('runs the same CAS, history, order flip and notification pipeline', async () => {
    const { sync, tx } = syncHarness(false);

    await sync.syncAll();

    expect(tx.shipment.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.shipmentHistory.create).toHaveBeenCalledTimes(1);
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.notificationOutbox.create).toHaveBeenCalledTimes(1);
  });

  it('uses the SAME tracking cache — no JNE-specific implementation', async () => {
    const { sync, store } = syncHarness(false);

    await sync.syncAll();

    expect([...store.keys()]).toEqual([`shipment:tracking:jne:${CNOTE}`]);
  });

  it('a cache HIT skips the JNE HTTP call', async () => {
    const { sync, trackShipmentRaw } = syncHarness(true);

    await sync.syncAll();

    expect(trackShipmentRaw).not.toHaveBeenCalled();
  });

  it('a cache MISS calls the JNE tracking API', async () => {
    const { sync, trackShipmentRaw } = syncHarness(false);

    await sync.syncAll();

    expect(trackShipmentRaw).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------- capabilities retained

describe('JNE keeps every capability except automatic booking', () => {
  it('still implements create, cancel and track', () => {
    // createShipment is kept on purpose — see the class comment. Removing it
    // would not make fulfilment more manual, only the integration incomplete.
    expect(typeof JneShipmentProvider.prototype.createShipment).toBe('function');
    expect(typeof JneShipmentProvider.prototype.cancelShipment).toBe('function');
    expect(typeof JneShipmentProvider.prototype.trackShipmentRaw).toBe('function');
  });
});
