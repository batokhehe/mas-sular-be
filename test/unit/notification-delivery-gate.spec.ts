import { NotificationChannel, OrderStatus, ShipmentStatus } from '@prisma/client';
import {
  NotificationBlockedError,
  NotificationDeliveryGate,
  loadNotificationDeliveryConfig,
  maskRecipient,
  normalizeRecipient,
} from '../../src/infrastructure/notifications/notification-delivery.gate';
import { NotificationSenderWorker } from '../../src/infrastructure/notifications/notification-sender.worker';
import { QontakWhatsAppProvider } from '../../src/infrastructure/notifications/qontak-whatsapp.provider';
import { EmailNotificationProvider } from '../../src/infrastructure/notifications/email-notification.provider';
import { ShipmentSyncService } from '../../src/modules/shipment/shipment-sync.service';

/**
 * PAXELBOX-31. Before this phase nothing stood between a NotificationOutbox row
 * and a real customer: `provider.send()` ran for whatever recipient the row
 * carried, the moment a Qontak template id existed.
 *
 * The gate sits at DELIVERY, in NotificationSenderWorker.sendRow, between the
 * builder and the provider factory — one boundary covering WhatsApp and Email,
 * with no recipient filtering inside either provider. Generation and
 * persistence are untouched: domain events still record their outbox rows.
 *
 * Two conditions must BOTH hold to send: delivery explicitly enabled, AND the
 * recipient explicitly allowlisted. Enabling delivery alone never means
 * "send to everyone", and there is no wildcard.
 */

const CUSTOMER_PHONE = '628581234308';
const CUSTOMER_EMAIL = 'customer@example.com';

function outboxRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'n1',
    channel: NotificationChannel.WHATSAPP,
    recipient: CUSTOMER_PHONE,
    template: 'shipment.status',
    payload: {},
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date(0),
    lockedUntil: null,
    lockedBy: 'w#1',
    providerMessageId: null,
    lastError: null,
    sourceMessageId: 's1',
    createdAt: new Date(0),
    sentAt: null,
    ...over,
  };
}

function senderConfig() {
  return {
    enabled: true,
    batchSize: 50,
    leaseMs: 30_000,
    pollIntervalMs: 1_000,
    backoffBaseMs: 5_000,
    backoffCapMs: 3_600_000,
    maxAttempts: 8,
    healthLogIntervalMs: 60_000,
    breakerThreshold: 5,
    pauseMs: 30_000,
    emailApiKey: 'test-key',
    emailFrom: 'shop@example.com',
    emailRequestTimeoutMs: 10_000,
  };
}

function metricsStub() {
  return {
    claimed: jest.fn(), sent: jest.fn(), retried: jest.fn(), failedPermanent: jest.fn(),
    failedExhausted: jest.fn(), senderPaused: jest.fn(), senderResumed: jest.fn(), health: jest.fn(),
  };
}

/** A registry stub so a REAL provider can be exercised without env template ids. */
const registryStub = { resolve: () => ({ providerTemplateId: 'tpl-1', body: [], button: false }) };

/**
 * Wires the worker with the REAL Qontak and Resend providers, each with its HTTP
 * seam replaced by a spy. If the gate ever let a blocked row through, these
 * spies would record an outbound call — that is what makes "no Qontak/Resend
 * call" a real assertion rather than a mock artifact.
 */
function build(opts: {
  env?: NodeJS.ProcessEnv;
  channel?: NotificationChannel;
  recipient?: string;
  rows?: ReturnType<typeof outboxRow>[];
}) {
  const channel = opts.channel ?? NotificationChannel.WHATSAPP;
  const rows = opts.rows ?? [outboxRow({ channel, recipient: opts.recipient ?? CUSTOMER_PHONE })];

  const qontakHttp = jest.fn(async () => ({
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ data: { id: 'qontak-1' } }),
  }));
  const resendHttp = jest.fn(async () => ({
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ id: 'resend-1' }),
  }));

  const qontak = new QontakWhatsAppProvider(
    { baseUrl: 'https://qontak.invalid', apiToken: 'tok', channelIntegrationId: 'cid', timeoutMs: 1_000, maxRetry: 1 } as never,
    registryStub as never,
  );
  (qontak as unknown as { http: unknown }).http = qontakHttp;

  const email = new EmailNotificationProvider(senderConfig() as never, { render: () => ({ subject: 's', text: 't' }) } as never, registryStub as never);
  (email as unknown as { http: unknown }).http = resendHttp;

  const factory = { get: jest.fn((c: NotificationChannel) => (c === NotificationChannel.EMAIL ? email : qontak)) };

  const prisma = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    notificationOutbox: {
      findMany: jest.fn().mockResolvedValue(rows),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  const builder = {
    build: jest.fn(async (r: { id: string; channel: NotificationChannel; template: string; recipient: string }) => ({
      channel: r.channel,
      template: r.template,
      recipient: {
        name: 'Pelanggan',
        // Mirrors the real builder: it normalizes the phone and carries the email.
        phone: r.channel === NotificationChannel.EMAIL ? undefined : normalizeRecipient(r.recipient) ?? undefined,
        email: r.channel === NotificationChannel.EMAIL ? r.recipient : undefined,
      },
      variables: { template: r.template },
      metadata: { notificationId: r.id, idempotencyKey: r.id, externalRequestId: 'x', providerTemplateId: 'tpl-1' },
    })),
  };

  const gate = new NotificationDeliveryGate(loadNotificationDeliveryConfig(opts.env ?? {}));
  const metrics = metricsStub();
  const worker = new NotificationSenderWorker(
    prisma as never, builder as never, factory as never, metrics as never, senderConfig() as never, gate,
  );
  const errorLogs: string[] = [];
  jest.spyOn((worker as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
    .mockImplementation((m: string) => { errorLogs.push(String(m)); });

  return { worker, prisma, factory, qontakHttp, resendHttp, metrics, errorLogs, gate };
}

/** The lastError persisted by the fenced write-back for the first row. */
function persistedError(prisma: { notificationOutbox: { updateMany: jest.Mock } }): string {
  const call = prisma.notificationOutbox.updateMany.mock.calls[0];
  return String((call[0] as { data: { lastError?: string } }).data.lastError ?? '');
}

// ---------------------------------------------------------------- 1,2,3,13

describe('delivery disabled (the default) blocks everything', () => {
  it('never calls provider.send — it never even resolves a provider', async () => {
    const { worker, factory } = build({ env: {} });

    await worker.processBatch();

    expect(factory.get).not.toHaveBeenCalled();
  });

  it('makes NO Qontak HTTP call', async () => {
    const { worker, qontakHttp } = build({ env: {} });

    await worker.processBatch();

    expect(qontakHttp).not.toHaveBeenCalled();
  });

  it('makes NO Resend HTTP call', async () => {
    const { worker, resendHttp } = build({ env: {}, channel: NotificationChannel.EMAIL, recipient: CUSTOMER_EMAIL });

    await worker.processBatch();

    expect(resendHttp).not.toHaveBeenCalled();
  });

  it('defaults to blocked when the flag is absent, empty or not exactly "true"', () => {
    for (const raw of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      const env = raw === undefined ? {} : { NOTIFICATION_DELIVERY_ENABLED: raw };
      expect(loadNotificationDeliveryConfig(env).enabled).toBe(false);
    }
    expect(loadNotificationDeliveryConfig({ NOTIFICATION_DELIVERY_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('records the row as terminally FAILED with an explicit reason', async () => {
    const { worker, prisma, metrics } = build({ env: {} });

    await worker.processBatch();

    const data = prisma.notificationOutbox.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('FAILED');
    expect(data.lastError).toContain('blocked by notification safety gate');
    expect(data.lastError).toContain('NOTIFICATION_DELIVERY_ENABLED');
    // Terminal, not a backoff: a blocked row must never schedule itself to
    // deliver later, or enabling delivery would flush the whole backlog.
    expect(data.nextAttemptAt).toBeUndefined();
    expect(metrics.retried).not.toHaveBeenCalled();
    expect(metrics.failedPermanent).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------ 4,5,13

describe('delivery enabled is NOT by itself permission to send', () => {
  it('blocks when the allowlist is empty', async () => {
    const { worker, qontakHttp, factory, prisma } = build({ env: { NOTIFICATION_DELIVERY_ENABLED: 'true' } });

    await worker.processBatch();

    expect(factory.get).not.toHaveBeenCalled();
    expect(qontakHttp).not.toHaveBeenCalled();
    expect(persistedError(prisma)).toContain('NOTIFICATION_ALLOWED_RECIPIENTS is empty');
  });

  it('blocks a recipient who is not on the allowlist', async () => {
    const { worker, qontakHttp, prisma } = build({
      env: { NOTIFICATION_DELIVERY_ENABLED: 'true', NOTIFICATION_ALLOWED_RECIPIENTS: '628999000111' },
    });

    await worker.processBatch();

    expect(qontakHttp).not.toHaveBeenCalled();
    expect(persistedError(prisma)).toContain('is not allowlisted');
  });

  it('has no wildcard — "*" is just an unusable entry, not "everyone"', async () => {
    const { worker, qontakHttp } = build({
      env: { NOTIFICATION_DELIVERY_ENABLED: 'true', NOTIFICATION_ALLOWED_RECIPIENTS: '*' },
    });

    await worker.processBatch();

    expect(loadNotificationDeliveryConfig({ NOTIFICATION_ALLOWED_RECIPIENTS: '*' }).allowedRecipients).toEqual([]);
    expect(qontakHttp).not.toHaveBeenCalled();
  });

  it('permits delivery when BOTH conditions hold', async () => {
    const { worker, qontakHttp, prisma } = build({
      env: { NOTIFICATION_DELIVERY_ENABLED: 'true', NOTIFICATION_ALLOWED_RECIPIENTS: CUSTOMER_PHONE },
    });

    await worker.processBatch();

    // A MOCK transport — no real Qontak endpoint is contacted.
    expect(qontakHttp).toHaveBeenCalledTimes(1);
    expect(prisma.notificationOutbox.updateMany.mock.calls[0][0].data.status).toBe('SENT');
  });
});

// -------------------------------------------------------------------- 6,7

describe('both channels obey the same one boundary', () => {
  it('WhatsApp is blocked and permitted by the same rules', async () => {
    const blocked = build({ env: { NOTIFICATION_DELIVERY_ENABLED: 'true' } });
    await blocked.worker.processBatch();
    expect(blocked.qontakHttp).not.toHaveBeenCalled();

    const allowed = build({
      env: { NOTIFICATION_DELIVERY_ENABLED: 'true', NOTIFICATION_ALLOWED_RECIPIENTS: CUSTOMER_PHONE },
    });
    await allowed.worker.processBatch();
    expect(allowed.qontakHttp).toHaveBeenCalledTimes(1);
  });

  it('Email is blocked and permitted by the same rules', async () => {
    const blocked = build({
      env: { NOTIFICATION_DELIVERY_ENABLED: 'true', NOTIFICATION_ALLOWED_RECIPIENTS: CUSTOMER_PHONE },
      channel: NotificationChannel.EMAIL, recipient: CUSTOMER_EMAIL,
    });
    await blocked.worker.processBatch();
    expect(blocked.resendHttp).not.toHaveBeenCalled();

    const allowed = build({
      env: { NOTIFICATION_DELIVERY_ENABLED: 'true', NOTIFICATION_ALLOWED_RECIPIENTS: CUSTOMER_EMAIL },
      channel: NotificationChannel.EMAIL, recipient: CUSTOMER_EMAIL,
    });
    await allowed.worker.processBatch();
    expect(allowed.resendHttp).toHaveBeenCalledTimes(1);
  });

  it('an allowlisted phone does not authorize an email, and vice versa', async () => {
    const { worker, resendHttp } = build({
      env: { NOTIFICATION_DELIVERY_ENABLED: 'true', NOTIFICATION_ALLOWED_RECIPIENTS: CUSTOMER_PHONE },
      channel: NotificationChannel.EMAIL, recipient: CUSTOMER_EMAIL,
    });

    await worker.processBatch();

    expect(resendHttp).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------- 11

describe('recipient normalization reuses the existing phone logic', () => {
  it('matches an 08… allowlist entry against a 628… message recipient', async () => {
    const { worker, qontakHttp } = build({
      // Operator writes the local form; the builder produced 628581234308.
      env: { NOTIFICATION_DELIVERY_ENABLED: 'true', NOTIFICATION_ALLOWED_RECIPIENTS: '0858-1234-308' },
    });

    await worker.processBatch();

    expect(normalizeRecipient('0858-1234-308')).toBe(CUSTOMER_PHONE);
    expect(qontakHttp).toHaveBeenCalledTimes(1);
  });

  it('case-folds emails and trims whitespace', () => {
    const cfg = loadNotificationDeliveryConfig({
      NOTIFICATION_ALLOWED_RECIPIENTS: '  Ops@Example.COM , +62 858 1234 308 ',
    });
    expect(cfg.allowedRecipients).toEqual(['ops@example.com', CUSTOMER_PHONE]);
  });

  it('drops unusable entries instead of widening the allowlist', () => {
    const cfg = loadNotificationDeliveryConfig({ NOTIFICATION_ALLOWED_RECIPIENTS: 'abc,,123,*' });
    expect(cfg.allowedRecipients).toEqual([]);
  });
});

// ---------------------------------------------------------------------- 12

describe('recipients never appear in full', () => {
  it('masks the recipient in the persisted lastError and in logs', async () => {
    const { worker, prisma, errorLogs } = build({
      env: { NOTIFICATION_DELIVERY_ENABLED: 'true', NOTIFICATION_ALLOWED_RECIPIENTS: '628999000111' },
    });

    await worker.processBatch();

    const stored = persistedError(prisma);
    expect(stored).not.toContain(CUSTOMER_PHONE);
    expect(stored).toContain(maskRecipient(CUSTOMER_PHONE));
    for (const line of errorLogs) expect(line).not.toContain(CUSTOMER_PHONE);
  });

  it('masks emails too', () => {
    expect(maskRecipient(CUSTOMER_EMAIL)).toBe('cu***@example.com');
    expect(maskRecipient(CUSTOMER_EMAIL)).not.toContain('customer@');
  });
});

// -------------------------------------------------------------------- 9,10

describe('existing FAILED rows stay dead unless someone acts deliberately', () => {
  it('the claim only ever considers PENDING rows', async () => {
    const { worker, prisma } = build({ env: {} });

    await worker.processBatch();

    expect(String(prisma.$executeRawUnsafe.mock.calls[0][0])).toContain("`status` = 'PENDING'");
    expect(prisma.notificationOutbox.findMany.mock.calls[0][0].where).toMatchObject({ status: 'PENDING' });
  });

  it('a resend that revived a row to PENDING is still blocked by the gate', async () => {
    // Exactly the state RedriveService leaves behind: FAILED → PENDING, attempts 0.
    const revived = outboxRow({ status: 'PENDING', attempts: 0, lastError: 'Provider template id missing for WHATSAPP/shipment.status' });
    const { worker, qontakHttp, factory, prisma } = build({ env: {}, rows: [revived] });

    await worker.processBatch();

    expect(factory.get).not.toHaveBeenCalled();
    expect(qontakHttp).not.toHaveBeenCalled();
    // Straight back to terminal FAILED — the resend bought nothing.
    expect(prisma.notificationOutbox.updateMany.mock.calls[0][0].data.status).toBe('FAILED');
  });

  it('a populated template id alone does not make a revived row sendable', async () => {
    // registryStub always resolves a template id, standing in for someone
    // filling QONTAK_SHIPMENT_TEMPLATE_ID. Delivery config still governs.
    const revived = outboxRow({ status: 'PENDING', attempts: 0 });
    const { worker, qontakHttp } = build({ env: {}, rows: [revived] });

    await worker.processBatch();

    expect(qontakHttp).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------- 8,14,15

describe('generation and tracking are untouched', () => {
  function trackingHarness(cached: boolean) {
    const tx = {
      shipment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      shipmentHistory: { create: jest.fn().mockResolvedValue({}) },
      notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
    };
    const trackShipmentRaw = jest.fn(async () => ({ providerStatus: 'DELIVERED', rawPayload: { detail: 'live' } }));
    const provider = { name: 'paxel', trackShipmentRaw };
    const store = new Map<string, unknown>();
    if (cached) store.set('shipment:tracking:paxel:AWB-1', { providerStatus: 'DELIVERED', rawPayload: { detail: 'cached' } });
    const cache = { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v) };
    const prisma = {
      shipment: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'sh1', provider: 'paxel', service: 'PAXEL_INSTANT', status: ShipmentStatus.IN_TRANSIT, trackingNumber: 'AWB-1',
          order: {
            id: 'o1', orderNumber: 'BMS-1', status: OrderStatus.SHIPPED,
            shippingService: 'PAXEL_INSTANT', shippingServiceName: 'Paxel Instant',
            user: { name: 'Budi', email: 'b@t.com', phone: CUSTOMER_PHONE }, address: { phone: CUSTOMER_PHONE },
          },
        }]),
      },
      $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    };
    const mapper = {
      map: () => ({ mapped: ShipmentStatus.DELIVERED, known: true }),
      toOrderStatus: () => OrderStatus.DELIVERED,
      label: () => 'Terkirim',
      shouldNotify: () => true,
    };
    const sync = new ShipmentSyncService(
      prisma as never, { get: () => provider, getAll: () => [provider] } as never, mapper as never, cache as never, undefined,
    );
    return { sync, tx, trackShipmentRaw };
  }

  it('the tracking worker still enqueues a notification row', async () => {
    const { sync, tx } = trackingHarness(false);

    await expect(sync.syncAll()).resolves.toBe(1);

    expect(tx.notificationOutbox.create).toHaveBeenCalledTimes(1);
  });

  it('a CACHED tracking response still runs the whole pipeline and enqueues', async () => {
    const { sync, tx, trackShipmentRaw } = trackingHarness(true);

    await expect(sync.syncAll()).resolves.toBe(1);

    // PAXELBOX-27 cache still serves the courier answer...
    expect(trackShipmentRaw).not.toHaveBeenCalled();
    // ...and PAXELBOX-25's CAS, history, order flip and enqueue are all intact.
    expect(tx.shipment.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.shipmentHistory.create).toHaveBeenCalledTimes(1);
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.notificationOutbox.create).toHaveBeenCalledTimes(1);
  });

  it('the sync service has no knowledge of the gate — generation is never suppressed', () => {
    // Constructed with 5 args and no gate; enqueueing cannot be gated by design.
    expect(ShipmentSyncService.length).toBeLessThanOrEqual(5);
  });
});

// ------------------------------------------------------------- gate unit

describe('the gate in isolation', () => {
  const message = (over: Record<string, unknown> = {}) => ({
    channel: NotificationChannel.WHATSAPP,
    template: 'shipment.status',
    recipient: { name: 'P', phone: CUSTOMER_PHONE },
    variables: {},
    metadata: {},
    ...over,
  }) as never;

  it('throws NotificationBlockedError, which the worker treats as terminal', () => {
    const gate = new NotificationDeliveryGate({ enabled: false, allowedRecipients: [] });
    expect(() => gate.assertDeliverable(message())).toThrow(NotificationBlockedError);
  });

  it('blocks a message carrying no recipient at all', () => {
    const gate = new NotificationDeliveryGate({ enabled: true, allowedRecipients: [CUSTOMER_PHONE] });
    expect(() => gate.assertDeliverable(message({ recipient: { name: 'P' } }))).toThrow(/no usable recipient/);
  });

  it('permits only an exact normalized match', () => {
    const gate = new NotificationDeliveryGate({ enabled: true, allowedRecipients: [CUSTOMER_PHONE] });
    expect(() => gate.assertDeliverable(message())).not.toThrow();
    expect(() => gate.assertDeliverable(message({ recipient: { name: 'P', phone: '628111222333' } }))).toThrow(/not allowlisted/);
  });
});
