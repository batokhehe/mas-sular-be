import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { NotificationChannel, NotificationStatus, OutboxStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { pageArgs, paginate } from '../../common/pagination/pagination';
import { RabbitConnectionManager } from '../outbox/rabbit-connection.manager';
import { RedriveService } from './redrive.service';
import { extractRelated, queueHealth } from './queue-center.util';
import { num } from '../../common/utils/number.util';

const CACHE_KEY = 'admin:queue-center';
const CACHE_TTL_MS = 30_000;
const RABBIT_PING_TIMEOUT_MS = 3_000;
const WORKER_STALE_MS = 15 * 60 * 1000;


const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? new Date(v as string).toISOString() : null);

export interface ListOutboxQuery {
  page?: number;
  limit?: number;
  status?: OutboxStatus;
  event?: string;
  aggregate?: string;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface ListQueueNotificationsQuery {
  page?: number;
  limit?: number;
  channel?: NotificationChannel;
  status?: NotificationStatus;
  template?: string;
  search?: string;
}

export interface TableStats {
  pending: number;
  processing: number;
  published: number;
  failed: number;
  retrying: number;
  oldestPending: string | null;
  lastActivity: string | null;
  lastFailure: string | null;
  avgPublishMs: number;
}

const EMPTY_STATS: TableStats = { pending: 0, processing: 0, published: 0, failed: 0, retrying: 0, oldestPending: null, lastActivity: null, lastFailure: null, avgPublishMs: 0 };

// Worker registry (same env flags the workers themselves gate on).
const WORKERS = [
  { key: 'outbox-relay', name: 'Outbox Relay', enabledEnv: 'OUTBOX_RELAY_ENABLED', source: 'outbox' as const },
  { key: 'notification-sender', name: 'Notification Sender', enabledEnv: 'NOTIFICATION_SENDER_ENABLED', source: 'notification' as const },
  { key: 'shipment-tracking', name: 'Shipment Tracking', enabledEnv: 'SHIPMENT_TRACKING_ENABLED', logModule: 'worker.shipment-tracking' },
  { key: 'inventory-reservation', name: 'Reservation', enabledEnv: 'INVENTORY_RESERVATION_WORKER_ENABLED', logModule: 'worker.inventory-reservation' },
  { key: 'payment-lifecycle', name: 'Payment Lifecycle', enabledEnv: 'PAYMENT_LIFECYCLE_ENABLED', logModule: 'worker.payment-lifecycle' },
  { key: 'retention', name: 'Retention', enabledEnv: 'RETENTION_ENABLED', logModule: 'worker.retention' },
  { key: 'log-retention', name: 'Log Retention', enabledEnv: 'SYSTEM_LOG_RETENTION_ENABLED', logModule: 'worker.log-retention' },
  { key: 'shipment-reconciliation', name: 'Shipment Reconciliation', enabledEnv: 'SHIPMENT_RECONCILIATION_ENABLED', logModule: 'worker.shipment-reconciliation' },
];

/**
 * Queue & Messaging Center — read-only aggregation over OutboxEvent /
 * NotificationOutbox / SystemLog worker ticks / the AMQP connection, plus manual
 * retry actions that DELEGATE to the existing RedriveService (FAILED → PENDING;
 * no new write semantics). Overview is 30s-cached; lists are always paginated.
 */
@Injectable()
export class QueueCenterService {
  private readonly logger = new Logger('QueueCenterService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redrive: RedriveService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Optional() private readonly rabbit?: RabbitConnectionManager,
  ) {}

  // ---------------- Overview (cached) ----------------

  async overview() {
    try {
      const cached = await this.cache.get<Awaited<ReturnType<QueueCenterService['compute']>>>(CACHE_KEY);
      if (cached) return cached;
    } catch {
      // cache unavailable → compute
    }
    const payload = await this.compute();
    try {
      await this.cache.set(CACHE_KEY, payload, CACHE_TTL_MS);
    } catch {
      // never fail on cache errors
    }
    return payload;
  }

  async compute() {
    const now = new Date();
    const [outbox, notifications, rabbitmq, workers, deadLetters] = await Promise.all([
      this.tableStats('OutboxEvent', now),
      this.tableStats('NotificationOutbox', now),
      this.rabbitStatus(),
      this.workerSummary(now),
      this.deadLetters(now),
    ]);

    const pending = outbox.pending + notifications.pending;
    const failed = outbox.failed + notifications.failed;
    return {
      summary: {
        pendingEvents: pending,
        processing: outbox.processing + notifications.processing,
        published: outbox.published + notifications.published,
        failed,
        retrying: outbox.retrying + notifications.retrying,
        deadLetters: failed,
        avgPublishMs: outbox.avgPublishMs,
        health: queueHealth(pending, failed),
      },
      outbox,
      notifications,
      rabbitmq,
      deadLetters,
      workers,
      generatedAt: now.toISOString(),
    };
  }

  private async tableStats(table: 'OutboxEvent' | 'NotificationOutbox', now: Date): Promise<TableStats> {
    try {
      const t = Prisma.raw(`\`${table}\``);
      const successState = table === 'OutboxEvent' ? 'PUBLISHED' : 'SENT';
      const doneCol = table === 'OutboxEvent' ? Prisma.raw('publishedAt') : Prisma.raw('sentAt');
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT
          SUM(status = 'PENDING') pending,
          SUM(status = 'PENDING' AND lockedUntil IS NOT NULL AND lockedUntil > ${now}) processing,
          SUM(status = ${successState}) published,
          SUM(status = 'FAILED') failed,
          SUM(status = 'PENDING' AND attempts > 0) retrying,
          MIN(CASE WHEN status = 'PENDING' THEN createdAt END) oldestPending,
          MAX(${doneCol}) lastActivity,
          MAX(CASE WHEN status = 'FAILED' THEN createdAt END) lastFailure,
          AVG(CASE WHEN status = ${successState} AND ${doneCol} IS NOT NULL THEN TIMESTAMPDIFF(MICROSECOND, createdAt, ${doneCol}) / 1000 END) avgPublishMs
        FROM ${t}
      `);
      const r = rows[0] ?? {};
      return {
        pending: num(r.pending), processing: num(r.processing), published: num(r.published),
        failed: num(r.failed), retrying: num(r.retrying),
        oldestPending: iso(r.oldestPending), lastActivity: iso(r.lastActivity), lastFailure: iso(r.lastFailure),
        avgPublishMs: Math.round(num(r.avgPublishMs)),
      };
    } catch (e) {
      this.logger.warn(`tableStats(${table}) failed: ${e instanceof Error ? e.message : e}`);
      return { ...EMPTY_STATS };
    }
  }

  /** AMQP connectivity ping. Full broker metrics need the management API (not integrated). */
  private async rabbitStatus() {
    const configured = !!process.env.RABBITMQ_URL;
    const base = { configured, metricsAvailable: false as const, lastPing: new Date().toISOString() };
    if (!configured || !this.rabbit) return { ...base, connected: false, latencyMs: null as number | null };
    const startedAt = Date.now();
    try {
      const channel = await Promise.race([
        this.rabbit.createConsumerChannel(0),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ping timeout')), RABBIT_PING_TIMEOUT_MS).unref()),
      ]);
      await channel.close().catch(() => undefined);
      return { ...base, connected: true, latencyMs: Date.now() - startedAt };
    } catch {
      return { ...base, connected: false, latencyMs: Date.now() - startedAt };
    }
  }

  private async workerSummary(now: Date) {
    let byModule = new Map<string, Record<string, unknown>>();
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT module,
          SUM(action = 'tick') success,
          SUM(action = 'tick.failed') failure,
          MAX(CASE WHEN action = 'tick' THEN createdAt END) lastSuccess,
          MAX(CASE WHEN action = 'tick.failed' THEN createdAt END) lastFailure,
          MAX(createdAt) heartbeat,
          AVG(durationMs) avgMs
        FROM \`SystemLog\` WHERE module LIKE 'worker.%' GROUP BY module
      `);
      byModule = new Map(rows.map((r) => [String(r.module), r]));
    } catch {
      // SystemLog unavailable → workers degrade to enabled/disabled only
    }
    // Event-driven workers (relay/sender) derive from their queue tables.
    const [outboxLast, notifLast] = await Promise.all([
      this.lastActivityOf('OutboxEvent'),
      this.lastActivityOf('NotificationOutbox'),
    ]);

    return WORKERS.map((w) => {
      const enabled = process.env[w.enabledEnv] === 'true';
      let success = 0, failure = 0, avgMs = 0;
      let lastSuccess: string | null = null, lastFailure: string | null = null, heartbeat: string | null = null;
      if ('logModule' in w && w.logModule) {
        const r = byModule.get(w.logModule);
        if (r) {
          success = num(r.success); failure = num(r.failure); avgMs = Math.round(num(r.avgMs));
          lastSuccess = iso(r.lastSuccess); lastFailure = iso(r.lastFailure); heartbeat = iso(r.heartbeat);
        }
      } else {
        const src = w.source === 'outbox' ? outboxLast : notifLast;
        lastSuccess = src.lastSuccess; lastFailure = src.lastFailure;
        heartbeat = lastSuccess && lastFailure ? (lastSuccess > lastFailure ? lastSuccess : lastFailure) : (lastSuccess ?? lastFailure);
        success = src.success; failure = src.failure;
      }
      const running = enabled && !!heartbeat && now.getTime() - new Date(heartbeat).getTime() < WORKER_STALE_MS;
      return { key: w.key, name: w.name, enabled, running, heartbeat, lastSuccess, lastFailure, success, failure, avgMs };
    });
  }

  private async lastActivityOf(table: 'OutboxEvent' | 'NotificationOutbox') {
    try {
      const t = Prisma.raw(`\`${table}\``);
      const successState = table === 'OutboxEvent' ? 'PUBLISHED' : 'SENT';
      const doneCol = table === 'OutboxEvent' ? Prisma.raw('publishedAt') : Prisma.raw('sentAt');
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT MAX(${doneCol}) lastSuccess,
               MAX(CASE WHEN status = 'FAILED' THEN createdAt END) lastFailure,
               SUM(status = ${successState}) success,
               SUM(status = 'FAILED') failure
        FROM ${t}
      `);
      const r = rows[0] ?? {};
      return { lastSuccess: iso(r.lastSuccess), lastFailure: iso(r.lastFailure), success: num(r.success), failure: num(r.failure) };
    } catch {
      return { lastSuccess: null, lastFailure: null, success: 0, failure: 0 };
    }
  }

  /** Most recent FAILED rows of each queue (top 10) + total counts, with ages. */
  private async deadLetters(now: Date) {
    try {
      const [outboxRows, notifRows, outboxCount, notifCount] = await Promise.all([
        this.prisma.outboxEvent.findMany({ where: { status: OutboxStatus.FAILED }, orderBy: { createdAt: 'desc' }, take: 10 }),
        this.prisma.notificationOutbox.findMany({ where: { status: NotificationStatus.FAILED }, orderBy: { createdAt: 'desc' }, take: 10 }),
        this.prisma.outboxEvent.count({ where: { status: OutboxStatus.FAILED } }),
        this.prisma.notificationOutbox.count({ where: { status: NotificationStatus.FAILED } }),
      ]);
      return {
        outboxCount,
        notificationCount: notifCount,
        outbox: outboxRows.map((r) => ({
          id: r.id, eventName: r.eventName, aggregateType: r.aggregateType, aggregateId: r.aggregateId,
          attempts: r.attempts, lastError: r.lastError, createdAt: r.createdAt.toISOString(),
          ageMs: now.getTime() - r.createdAt.getTime(), related: extractRelated(r.payload),
        })),
        notifications: notifRows.map((r) => ({
          id: r.id, channel: r.channel, template: r.template, recipient: r.recipient,
          attempts: r.attempts, lastError: r.lastError, createdAt: r.createdAt.toISOString(),
          ageMs: now.getTime() - r.createdAt.getTime(), related: extractRelated(r.payload),
        })),
      };
    } catch (e) {
      this.logger.warn(`deadLetters failed: ${e instanceof Error ? e.message : e}`);
      return { outboxCount: 0, notificationCount: 0, outbox: [], notifications: [] };
    }
  }

  // ---------------- Paginated lists ----------------

  buildOutboxWhere(query: ListOutboxQuery): Prisma.OutboxEventWhereInput {
    const term = query.search?.trim();
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.dateFrom) createdAt.gte = query.dateFrom;
    if (query.dateTo) createdAt.lte = query.dateTo;
    return {
      status: query.status,
      ...(query.event ? { eventName: { contains: query.event } } : {}),
      ...(query.aggregate ? { aggregateType: { contains: query.aggregate } } : {}),
      ...(query.dateFrom || query.dateTo ? { createdAt } : {}),
      ...(term
        ? {
            OR: [
              { id: term },
              { aggregateId: term },
              { eventName: { contains: term } },
              { routingKey: { contains: term } },
              // Order number / payment id / phone / email / requestId live inside the payload JSON.
              { payload: { string_contains: term } },
            ],
          }
        : {}),
    };
  }

  async listOutbox(query: ListOutboxQuery) {
    const { skip, take, page, limit } = pageArgs(query);
    const where = this.buildOutboxWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.outboxEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.outboxEvent.count({ where }),
    ]);
    const items = rows.map((r) => ({
      id: r.id, createdAt: r.createdAt.toISOString(), eventName: r.eventName, eventVersion: r.eventVersion,
      aggregateType: r.aggregateType, aggregateId: r.aggregateId, exchange: r.exchange, routingKey: r.routingKey,
      status: r.status, attempts: r.attempts, maxAttempts: r.maxAttempts,
      nextAttemptAt: iso(r.nextAttemptAt), publishedAt: iso(r.publishedAt), lastError: r.lastError,
      payload: r.payload, metadata: r.metadata, related: extractRelated(r.payload),
    }));
    return paginate(items, total, page, limit);
  }

  buildNotificationWhere(query: ListQueueNotificationsQuery): Prisma.NotificationOutboxWhereInput {
    const term = query.search?.trim();
    return {
      channel: query.channel,
      status: query.status,
      ...(query.template ? { template: { contains: query.template } } : {}),
      ...(term
        ? {
            OR: [
              { id: term },
              { recipient: { contains: term } },
              { sourceMessageId: term },
              { payload: { string_contains: term } },
            ],
          }
        : {}),
    };
  }

  async listNotifications(query: ListQueueNotificationsQuery) {
    const { skip, take, page, limit } = pageArgs(query);
    const where = this.buildNotificationWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.notificationOutbox.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.notificationOutbox.count({ where }),
    ]);
    const items = rows.map((r) => ({
      id: r.id, createdAt: r.createdAt.toISOString(), channel: r.channel, template: r.template,
      recipient: r.recipient, status: r.status, attempts: r.attempts,
      nextAttemptAt: iso(r.nextAttemptAt), sentAt: iso(r.sentAt), lastError: r.lastError,
      providerMessageId: r.providerMessageId, sourceMessageId: r.sourceMessageId,
      payload: r.payload, related: extractRelated(r.payload),
    }));
    return paginate(items, total, page, limit);
  }

  // ---------------- Retry actions (delegate to RedriveService) ----------------

  async retryOutbox(id: string) {
    const row = await this.prisma.outboxEvent.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!row) throw new NotFoundException('Outbox event not found');
    if (row.status !== OutboxStatus.FAILED) throw new BadRequestException('Only FAILED events can be retried');
    const result = await this.redrive.redriveFailedOutboxEvents({ id });
    await this.invalidate();
    return result;
  }

  async retryNotification(id: string) {
    const row = await this.prisma.notificationOutbox.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!row) throw new NotFoundException('Notification not found');
    if (row.status !== NotificationStatus.FAILED) throw new BadRequestException('Only FAILED notifications can be retried');
    const result = await this.redrive.redriveFailedNotifications({ id });
    await this.invalidate();
    return result;
  }

  async retryAllFailed(target: 'outbox' | 'notifications' | 'all' = 'all') {
    const [outbox, notifications] = await Promise.all([
      target !== 'notifications' ? this.redrive.redriveFailedOutboxEvents({}) : Promise.resolve(null),
      target !== 'outbox' ? this.redrive.redriveFailedNotifications({}) : Promise.resolve(null),
    ]);
    await this.invalidate();
    return { outbox, notifications };
  }

  private async invalidate(): Promise<void> {
    try {
      await this.cache.del(CACHE_KEY);
    } catch {
      // stale-for-≤30s is acceptable if the cache is unreachable
    }
  }
}
