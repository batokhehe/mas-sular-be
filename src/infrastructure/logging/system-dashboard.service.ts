import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { num } from '../../common/utils/number.util';

export type HealthColor = 'green' | 'yellow' | 'red' | 'gray';

const CACHE_KEY = 'admin:system-dashboard';
const CACHE_TTL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A worker is "recent" (running) if it logged within this window.
const WORKER_STALE_MS = 15 * 60 * 1000;


const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? new Date(v as string).toISOString() : null);

// Worker registry — name + env flag + SystemLog module (or table-derived source).
interface WorkerDef {
  key: string;
  name: string;
  enabledEnv: string;
  logModule?: string; // present → metrics come from SystemLog `worker.*`
  source?: 'outbox' | 'notification'; // event-driven workers derive from their queue table
}
const WORKERS: WorkerDef[] = [
  { key: 'payment-lifecycle', name: 'Payment Lifecycle', enabledEnv: 'PAYMENT_LIFECYCLE_ENABLED', logModule: 'worker.payment-lifecycle' },
  { key: 'inventory-reservation', name: 'Reservation', enabledEnv: 'INVENTORY_RESERVATION_WORKER_ENABLED', logModule: 'worker.inventory-reservation' },
  { key: 'shipment-tracking', name: 'Shipment Tracking', enabledEnv: 'SHIPMENT_TRACKING_ENABLED', logModule: 'worker.shipment-tracking' },
  { key: 'shipment-reconciliation', name: 'Shipment Reconciliation', enabledEnv: 'SHIPMENT_RECONCILIATION_ENABLED', logModule: 'worker.shipment-reconciliation' },
  { key: 'notification-sender', name: 'Notification Sender', enabledEnv: 'NOTIFICATION_SENDER_ENABLED', source: 'notification' },
  { key: 'outbox-relay', name: 'Outbox Relay', enabledEnv: 'OUTBOX_RELAY_ENABLED', source: 'outbox' },
  { key: 'retention', name: 'Retention', enabledEnv: 'RETENTION_ENABLED', logModule: 'worker.retention' },
  { key: 'log-retention', name: 'Log Retention', enabledEnv: 'SYSTEM_LOG_RETENTION_ENABLED', logModule: 'worker.log-retention' },
];

/**
 * Read-only observability dashboard aggregation. One entry point (getDashboard),
 * 30s-cached, fanning out every section with Promise.all. Never mutates state and
 * degrades gracefully — a failing section returns empty rather than 500-ing the page.
 */
@Injectable()
export class SystemDashboardService {
  private readonly logger = new Logger('SystemDashboardService');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async getDashboard() {
    try {
      const cached = await this.cache.get<Awaited<ReturnType<SystemDashboardService['compute']>>>(CACHE_KEY);
      if (cached) return cached;
    } catch {
      // cache miss / unavailable → compute
    }
    const payload = await this.compute();
    try {
      await this.cache.set(CACHE_KEY, payload, CACHE_TTL_MS);
    } catch {
      // never fail the dashboard on cache errors
    }
    return payload;
  }

  async compute() {
    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const since24h = new Date(now.getTime() - DAY_MS);

    const [requestMetrics, errorMetrics, queueMetrics, notificationMetrics, workerAgg, databaseMetrics, cacheMetrics, todayCounts] = await Promise.all([
      this.requestMetrics(since24h),
      this.errorMetrics(since24h, todayStart),
      this.queueMetrics(now),
      this.notificationMetrics(),
      this.workerAggregates(),
      this.databaseMetrics(todayStart),
      this.cacheMetrics(),
      this.todayCounts(todayStart),
    ]);

    const workerMetrics = this.buildWorkers(workerAgg, queueMetrics, notificationMetrics, now);
    const requestsToday = todayCounts.requests;
    const errorsToday = todayCounts.errors;

    return {
      summary: {
        totalRequestsToday: requestsToday,
        avgResponseTimeMs: todayCounts.avgMs,
        errorRatePct: requestsToday > 0 ? Math.round((errorsToday / requestsToday) * 1000) / 10 : 0,
        warningsToday: todayCounts.warnings,
        errorsToday,
        activeWorkers: workerMetrics.filter((w) => w.running).length,
        pendingNotifications: queueMetrics.notification.pending,
        pendingQueue: queueMetrics.outbox.pending,
      },
      requestMetrics,
      errorMetrics,
      queueMetrics,
      notificationMetrics,
      workerMetrics,
      databaseMetrics,
      cacheMetrics,
      generatedAt: now.toISOString(),
    };
  }

  // ---------------- 1. today's counters ----------------
  private async todayCounts(todayStart: Date) {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ requests: unknown; avgMs: unknown; warnings: unknown; errors: unknown }>>(Prisma.sql`
        SELECT
          SUM(module = 'http') AS requests,
          AVG(CASE WHEN module = 'http' THEN durationMs END) AS avgMs,
          SUM(level = 'WARN') AS warnings,
          SUM(level = 'ERROR') AS errors
        FROM \`SystemLog\` WHERE createdAt >= ${todayStart}
      `);
      const r = rows[0] ?? {};
      return { requests: num(r.requests), avgMs: Math.round(num(r.avgMs)), warnings: num(r.warnings), errors: num(r.errors) };
    } catch (e) {
      this.logger.warn(`todayCounts failed: ${e instanceof Error ? e.message : e}`);
      return { requests: 0, avgMs: 0, warnings: 0, errors: 0 };
    }
  }

  // ---------------- 2. request metrics ----------------
  private async requestMetrics(since: Date) {
    const [perHour, p95Ms, topEndpoints, slowestEndpoints] = await Promise.all([
      this.hourly(since, "module = 'http'", true),
      this.requestP95(since),
      this.endpointAgg(since, 'count'),
      this.endpointAgg(since, 'slow'),
    ]);
    return { perHour, p95Ms, topEndpoints, slowestEndpoints };
  }

  private async requestP95(since: Date): Promise<number> {
    try {
      const cnt = await this.prisma.$queryRaw<Array<{ n: unknown }>>(Prisma.sql`SELECT COUNT(*) n FROM \`SystemLog\` WHERE module='http' AND durationMs IS NOT NULL AND createdAt >= ${since}`);
      const total = num(cnt[0]?.n);
      if (total === 0) return 0;
      const offset = Math.min(total - 1, Math.floor(total * 0.95));
      const rows = await this.prisma.$queryRaw<Array<{ d: unknown }>>(Prisma.sql`SELECT durationMs d FROM \`SystemLog\` WHERE module='http' AND durationMs IS NOT NULL AND createdAt >= ${since} ORDER BY durationMs ASC LIMIT 1 OFFSET ${offset}`);
      return num(rows[0]?.d);
    } catch {
      return 0;
    }
  }

  private async endpointAgg(since: Date, mode: 'count' | 'slow') {
    try {
      // Normalize concrete ids (UUID / numeric segments) → :id so routes group together.
      const rows = await this.prisma.$queryRaw<Array<{ endpoint: string; c: unknown; avgMs: unknown; maxMs: unknown }>>(Prisma.sql`
        SELECT CONCAT(method, ' ', REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(path, ''), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', ':id'), '/[0-9]+', '/:id')) AS endpoint,
               COUNT(*) c, AVG(durationMs) avgMs, MAX(durationMs) maxMs
        FROM \`SystemLog\`
        WHERE module = 'http' AND createdAt >= ${since}
        GROUP BY endpoint
        ORDER BY ${mode === 'slow' ? Prisma.sql`AVG(durationMs) DESC` : Prisma.sql`c DESC`}
        LIMIT 10
      `);
      return rows.map((r) => ({ endpoint: r.endpoint, count: num(r.c), avgMs: Math.round(num(r.avgMs)), maxMs: num(r.maxMs) }));
    } catch (e) {
      this.logger.warn(`endpointAgg(${mode}) failed: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  // ---------------- 3. error metrics ----------------
  private async errorMetrics(since24h: Date, _todayStart: Date) {
    const [byHour, byModule, byAction, topRecurring] = await Promise.all([
      this.hourly(since24h, "level = 'ERROR'", false),
      this.groupCount(since24h, 'module'),
      this.groupCount(since24h, 'action'),
      this.topMessages(since24h),
    ]);
    return { byHour, byModule, byAction, topRecurring };
  }

  private async groupCount(since: Date, col: 'module' | 'action') {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ k: string; c: unknown }>>(Prisma.sql`
        SELECT ${Prisma.raw(`\`${col}\``)} k, COUNT(*) c FROM \`SystemLog\`
        WHERE level = 'ERROR' AND createdAt >= ${since} GROUP BY k ORDER BY c DESC LIMIT 20
      `);
      return rows.map((r) => ({ key: r.k, count: num(r.c) }));
    } catch {
      return [];
    }
  }

  private async topMessages(since: Date) {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ message: string; c: unknown }>>(Prisma.sql`
        SELECT LEFT(message, 200) message, COUNT(*) c FROM \`SystemLog\`
        WHERE level = 'ERROR' AND createdAt >= ${since} GROUP BY LEFT(message, 200) ORDER BY c DESC LIMIT 10
      `);
      return rows.map((r) => ({ message: r.message, count: num(r.c) }));
    } catch {
      return [];
    }
  }

  // ---------------- 4. queue metrics ----------------
  private async queueMetrics(now: Date) {
    const [outbox, notification] = await Promise.all([this.queueOne('OutboxEvent', now), this.queueOne('NotificationOutbox', now)]);
    return { outbox, notification };
  }

  private async queueOne(table: 'OutboxEvent' | 'NotificationOutbox', now: Date) {
    const empty = { pending: 0, processing: 0, failed: 0, published: 0, oldestPending: null as string | null, retryCount: 0, lastActivity: null as string | null };
    try {
      const t = Prisma.raw(`\`${table}\``);
      const lastCol = table === 'OutboxEvent' ? Prisma.raw('publishedAt') : Prisma.raw('sentAt');
      const successState = table === 'OutboxEvent' ? 'PUBLISHED' : 'SENT';
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT
          SUM(status = 'PENDING') pending,
          SUM(status = 'PENDING' AND lockedUntil IS NOT NULL AND lockedUntil > ${now}) processing,
          SUM(status = 'FAILED') failed,
          SUM(status = ${successState}) published,
          MIN(CASE WHEN status = 'PENDING' THEN createdAt END) oldestPending,
          SUM(attempts > 0) retryCount,
          MAX(${lastCol}) lastActivity
        FROM ${t}
      `);
      const r = rows[0] ?? {};
      return { pending: num(r.pending), processing: num(r.processing), failed: num(r.failed), published: num(r.published), oldestPending: iso(r.oldestPending), retryCount: num(r.retryCount), lastActivity: iso(r.lastActivity) };
    } catch (e) {
      this.logger.warn(`queueOne(${table}) failed: ${e instanceof Error ? e.message : e}`);
      return empty;
    }
  }

  // ---------------- 5. notification metrics ----------------
  private async notificationMetrics() {
    const blank = { success: 0, failed: 0, retry: 0, avgSendSec: 0, lastSuccess: null as string | null, lastFailure: null as string | null };
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT channel,
          SUM(status = 'SENT') success,
          SUM(status = 'FAILED') failed,
          SUM(attempts > 0) retry,
          AVG(CASE WHEN status = 'SENT' AND sentAt IS NOT NULL THEN TIMESTAMPDIFF(SECOND, createdAt, sentAt) END) avgSendSec,
          MAX(CASE WHEN status = 'SENT' THEN sentAt END) lastSuccess,
          MAX(CASE WHEN status = 'FAILED' THEN createdAt END) lastFailure
        FROM \`NotificationOutbox\` GROUP BY channel
      `);
      const pick = (ch: string) => {
        const r = rows.find((x) => x.channel === ch);
        if (!r) return blank;
        return { success: num(r.success), failed: num(r.failed), retry: num(r.retry), avgSendSec: Math.round(num(r.avgSendSec)), lastSuccess: iso(r.lastSuccess), lastFailure: iso(r.lastFailure) };
      };
      return { whatsapp: pick('WHATSAPP'), email: pick('EMAIL') };
    } catch (e) {
      this.logger.warn(`notificationMetrics failed: ${e instanceof Error ? e.message : e}`);
      return { whatsapp: blank, email: blank };
    }
  }

  // ---------------- 6. workers ----------------
  private async workerAggregates() {
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT module, SUM(action = 'tick') success, SUM(action = 'tick.failed') failure, MAX(createdAt) lastExecution, AVG(durationMs) avgMs
        FROM \`SystemLog\` WHERE module LIKE 'worker.%' GROUP BY module
      `);
      return new Map(rows.map((r) => [String(r.module), r]));
    } catch {
      return new Map<string, Record<string, unknown>>();
    }
  }

  private buildWorkers(
    agg: Map<string, Record<string, unknown>>,
    queue: { outbox: { published: number; failed: number; lastActivity: string | null }; notification: { published: number; failed: number; lastActivity: string | null } },
    _notif: unknown,
    now: Date,
  ) {
    return WORKERS.map((w) => {
      const enabled = process.env[w.enabledEnv] === 'true';
      let success = 0, failure = 0, lastExecution: string | null = null, avgMs = 0;
      if (w.logModule) {
        const r = agg.get(w.logModule);
        if (r) { success = num(r.success); failure = num(r.failure); lastExecution = iso(r.lastExecution); avgMs = Math.round(num(r.avgMs)); }
      } else if (w.source === 'outbox') {
        success = queue.outbox.published; failure = queue.outbox.failed; lastExecution = queue.outbox.lastActivity;
      } else if (w.source === 'notification') {
        success = queue.notification.published; failure = queue.notification.failed; lastExecution = queue.notification.lastActivity;
      }
      const recent = !!lastExecution && now.getTime() - new Date(lastExecution).getTime() < WORKER_STALE_MS;
      const status: HealthColor = !enabled ? 'gray' : failure > success ? 'red' : recent ? 'green' : 'yellow';
      return { key: w.key, name: w.name, enabled, running: enabled && recent, status, lastExecution, lastHeartbeat: lastExecution, success, failure, avgMs };
    });
  }

  // ---------------- 7. database ----------------
  private async databaseMetrics(todayStart: Date) {
    try {
      const [agg, avgCheckout] = await Promise.all([
        this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT
            (SELECT COUNT(*) FROM \`Order\` WHERE deletedAt IS NULL) totalOrders,
            (SELECT COUNT(*) FROM \`Order\` WHERE deletedAt IS NULL AND createdAt >= ${todayStart}) todayOrders,
            (SELECT COUNT(*) FROM \`Payment\` WHERE deletedAt IS NULL AND createdAt >= ${todayStart}) todayPayments,
            (SELECT COUNT(*) FROM \`Shipment\` WHERE createdAt >= ${todayStart}) todayShipments,
            (SELECT COUNT(*) FROM \`User\` WHERE deletedAt IS NULL) totalCustomers
        `),
        this.prisma.$queryRaw<Array<{ avgMs: unknown }>>(Prisma.sql`
          SELECT AVG(durationMs) avgMs FROM \`SystemLog\` WHERE module='http' AND method='POST' AND path LIKE '%/checkout/order'
        `),
      ]);
      const r = agg[0] ?? {};
      return {
        totalOrders: num(r.totalOrders), todayOrders: num(r.todayOrders), todayPayments: num(r.todayPayments),
        todayShipments: num(r.todayShipments), totalCustomers: num(r.totalCustomers), avgCheckoutMs: Math.round(num(avgCheckout[0]?.avgMs)),
      };
    } catch (e) {
      this.logger.warn(`databaseMetrics failed: ${e instanceof Error ? e.message : e}`);
      return { totalOrders: 0, todayOrders: 0, todayPayments: 0, todayShipments: 0, totalCustomers: 0, avgCheckoutMs: 0 };
    }
  }

  // ---------------- 8. cache (Redis) ----------------
  private async cacheMetrics() {
    const startedAt = Date.now();
    try {
      await this.cache.set('system-dashboard:ping', 'ok', 5_000);
      const ok = (await this.cache.get<string>('system-dashboard:ping')) === 'ok';
      return { connected: ok, latencyMs: Date.now() - startedAt, lastPing: new Date().toISOString(), memory: null as string | null };
    } catch {
      return { connected: false, latencyMs: Date.now() - startedAt, lastPing: new Date().toISOString(), memory: null as string | null };
    }
  }

  // ---------------- shared: hourly bucket ----------------
  private async hourly(since: Date, predicate: string, withAvg: boolean) {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ hour: string; c: unknown; avgMs: unknown }>>(Prisma.sql`
        SELECT DATE_FORMAT(createdAt, '%Y-%m-%d %H:00') hour, COUNT(*) c, AVG(durationMs) avgMs
        FROM \`SystemLog\` WHERE ${Prisma.raw(predicate)} AND createdAt >= ${since}
        GROUP BY hour ORDER BY hour ASC
      `);
      return rows.map((r) => ({ hour: r.hour, count: num(r.c), avgMs: withAvg ? Math.round(num(r.avgMs)) : 0 }));
    } catch (e) {
      this.logger.warn(`hourly failed: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }
}
