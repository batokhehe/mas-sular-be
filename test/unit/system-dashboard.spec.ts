import { SystemDashboardService } from '../../src/infrastructure/logging/system-dashboard.service';

function sqlText(arg: unknown): string {
  if (arg && typeof arg === 'object' && Array.isArray((arg as { strings?: unknown }).strings)) {
    return (arg as { strings: string[] }).strings.join(' ');
  }
  return String(arg ?? '');
}

const RECENT = new Date(Date.now() - 60_000); // 1 min ago → "recent"

// Route each raw query by a distinctive token in its SQL.
function queryRaw(arg: unknown): Promise<unknown[]> {
  const t = sqlText(arg);
  if (t.includes("SUM(module = 'http')")) return Promise.resolve([{ requests: 100, avgMs: 42, warnings: 3, errors: 5 }]);
  if (t.includes('DATE_FORMAT') && t.includes("module = 'http'")) return Promise.resolve([{ hour: '2026-07-07 10:00', c: 10, avgMs: 40 }]);
  if (t.includes('DATE_FORMAT') && t.includes("level = 'ERROR'")) return Promise.resolve([{ hour: '2026-07-07 10:00', c: 2, avgMs: 0 }]);
  if (t.includes('COUNT(*) n FROM')) return Promise.resolve([{ n: 100 }]);
  if (t.includes('ORDER BY durationMs ASC')) return Promise.resolve([{ d: 250 }]);
  if (t.includes('CONCAT(method')) return Promise.resolve([{ endpoint: 'GET /products', c: 50, avgMs: 30, maxMs: 120 }]);
  if (t.includes('GROUP BY LEFT(message')) return Promise.resolve([{ message: 'Voucher expired', c: 125 }]);
  if (t.includes('GROUP BY k')) return Promise.resolve([{ k: 'exception', c: 12 }]);
  if (t.includes('GROUP BY channel')) return Promise.resolve([{ channel: 'WHATSAPP', success: 80, failed: 5, retry: 3, avgSendSec: 12, lastSuccess: RECENT, lastFailure: null }, { channel: 'EMAIL', success: 40, failed: 2, retry: 1, avgSendSec: 8, lastSuccess: RECENT, lastFailure: null }]);
  if (t.includes("module LIKE 'worker.%'")) return Promise.resolve([{ module: 'worker.payment-lifecycle', success: 20, failure: 1, lastExecution: RECENT, avgMs: 15 }]);
  if (t.includes('totalOrders')) return Promise.resolve([{ totalOrders: 500, todayOrders: 12, todayPayments: 10, todayShipments: 8, totalCustomers: 300 }]);
  if (t.includes("path LIKE '%/checkout/order'")) return Promise.resolve([{ avgMs: 230 }]);
  if (t.includes('FROM `OutboxEvent`')) return Promise.resolve([{ pending: 4, processing: 1, failed: 2, published: 10, oldestPending: RECENT, retryCount: 3, lastActivity: RECENT }]);
  if (t.includes('FROM `NotificationOutbox`')) return Promise.resolve([{ pending: 2, processing: 0, failed: 1, published: 120, oldestPending: RECENT, retryCount: 2, lastActivity: RECENT }]);
  return Promise.resolve([]);
}

function svc() {
  const prisma = { $queryRaw: jest.fn().mockImplementation(queryRaw) };
  const cache = {
    get: jest.fn().mockImplementation(async (k: string) => (k === 'system-dashboard:ping' ? 'ok' : undefined)),
    set: jest.fn().mockResolvedValue(undefined),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service: new SystemDashboardService(prisma as any, cache as any), prisma, cache };
}

describe('SystemDashboardService.compute', () => {
  // Worker rows are derived from ambient environment variables, so every flag
  // this block asserts on is pinned here and restored afterwards. Previously
  // only PAYMENT_LIFECYCLE_ENABLED was pinned and the shipment-tracking
  // assertion silently relied on the var being unset — which made the suite
  // fail the moment tracking was switched on in configuration.
  const ENV_UNDER_TEST: Record<string, string> = {
    PAYMENT_LIFECYCLE_ENABLED: 'true',
    // The intended production configuration: tracking is ON.
    SHIPMENT_TRACKING_ENABLED: 'true',
    // Held OFF so the disabled/gray rendering path stays covered by a worker
    // that is genuinely disabled, rather than by an accident of the .env file.
    SHIPMENT_RECONCILIATION_ENABLED: 'false',
  };
  const prev: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [key, value] of Object.entries(ENV_UNDER_TEST)) {
      prev[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('summary: request count, avg response, error rate, warnings/errors', async () => {
    const d = await svc().service.compute();
    expect(d.summary).toMatchObject({ totalRequestsToday: 100, avgResponseTimeMs: 42, errorRatePct: 5, warningsToday: 3, errorsToday: 5, pendingNotifications: 2, pendingQueue: 4 });
  });

  it('request metrics: p95 + top endpoints', async () => {
    const d = await svc().service.compute();
    expect(d.requestMetrics.p95Ms).toBe(250);
    expect(d.requestMetrics.topEndpoints[0]).toMatchObject({ endpoint: 'GET /products', count: 50, avgMs: 30, maxMs: 120 });
  });

  it('error metrics: top recurring errors aggregated by message', async () => {
    const d = await svc().service.compute();
    expect(d.errorMetrics.topRecurring[0]).toEqual({ message: 'Voucher expired', count: 125 });
  });

  it('queue metrics: outbox + notification pending/failed/retry', async () => {
    const d = await svc().service.compute();
    expect(d.queueMetrics.outbox).toMatchObject({ pending: 4, processing: 1, failed: 2, retryCount: 3 });
    expect(d.queueMetrics.notification).toMatchObject({ pending: 2, failed: 1 });
  });

  it('notification metrics: WhatsApp + Email split', async () => {
    const d = await svc().service.compute();
    expect(d.notificationMetrics.whatsapp).toMatchObject({ success: 80, failed: 5, retry: 3, avgSendSec: 12 });
    expect(d.notificationMetrics.email).toMatchObject({ success: 40, failed: 2 });
  });

  it('database metrics use aggregates', async () => {
    const d = await svc().service.compute();
    expect(d.databaseMetrics).toMatchObject({ totalOrders: 500, todayOrders: 12, todayPayments: 10, todayShipments: 8, totalCustomers: 300, avgCheckoutMs: 230 });
  });

  it('cache metrics: Redis connected + latency', async () => {
    const d = await svc().service.compute();
    expect(d.cacheMetrics.connected).toBe(true);
    expect(typeof d.cacheMetrics.latencyMs).toBe('number');
  });

  it('worker metrics: enabled worker with recent SystemLog tick is green/running', async () => {
    const d = await svc().service.compute();
    const pl = d.workerMetrics.find((w) => w.key === 'payment-lifecycle');
    expect(pl).toMatchObject({ enabled: true, running: true, status: 'green', success: 20, failure: 1, avgMs: 15 });
    expect(d.summary.activeWorkers).toBeGreaterThanOrEqual(1);
    // Tracking is ENABLED in the intended configuration. This fixture logs no
    // tracking tick, so it is enabled-but-not-yet-observed: running false and
    // yellow (a warning), which is distinct from a disabled worker's gray.
    const tracking = d.workerMetrics.find((w) => w.key === 'shipment-tracking');
    expect(tracking).toMatchObject({ enabled: true, running: false, status: 'yellow' });
    // A genuinely disabled worker is gray + not running.
    const disabled = d.workerMetrics.find((w) => w.key === 'shipment-reconciliation');
    expect(disabled).toMatchObject({ enabled: false, running: false, status: 'gray' });
  });
});

describe('SystemDashboardService.getDashboard caching', () => {
  it('returns the cached payload without recomputing on a hit', async () => {
    const prisma = { $queryRaw: jest.fn() };
    const cache = { get: jest.fn().mockResolvedValue({ cached: true }), set: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new SystemDashboardService(prisma as any, cache as any);
    expect(await service.getDashboard()).toEqual({ cached: true });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('computes then writes to cache (30s TTL) on a miss', async () => {
    const { service, cache } = svc();
    await service.getDashboard();
    expect(cache.set).toHaveBeenCalledWith('admin:system-dashboard', expect.any(Object), 30_000);
  });
});
