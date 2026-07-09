import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { NotificationChannel, NotificationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { pageArgs, paginate } from '../../common/pagination/pagination';
import { TemplateRenderer } from '../notifications/template-renderer';
import { RedriveService } from './redrive.service';
import { extractRelated } from './queue-center.util';

const CACHE_KEY = 'admin:notification-center';
const CACHE_TTL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function num(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (v === null || v === undefined) return 0;
  return Number(v);
}
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? new Date(v as string).toISOString() : null);

export interface ListNotificationCenterQuery {
  page?: number;
  limit?: number;
  channel?: NotificationChannel;
  status?: NotificationStatus;
  template?: string;
  recipient?: string;
  order?: string;
  payment?: string;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

/**
 * Notification Center — read-only monitoring over the EXISTING NotificationOutbox
 * pipeline (WhatsApp/Email today; PUSH/SMS channels are already in the enum and
 * flow through unchanged). The only write is manual resend, which DELEGATES to the
 * existing RedriveService (FAILED → PENDING; the sender worker re-delivers with
 * the row id as the provider idempotency key). Overview is 30s-cached.
 */
@Injectable()
export class NotificationCenterService {
  private readonly logger = new Logger('NotificationCenterService');
  // Pure, dependency-free renderer — reused ONLY to derive display subjects.
  private readonly renderer = new TemplateRenderer();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redrive: RedriveService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ---------------- Overview (30s cached) ----------------

  async overview() {
    try {
      const cached = await this.cache.get<Awaited<ReturnType<NotificationCenterService['computeOverview']>>>(CACHE_KEY);
      if (cached) return cached;
    } catch {
      // cache unavailable → compute
    }
    const payload = await this.computeOverview();
    try {
      await this.cache.set(CACHE_KEY, payload, CACHE_TTL_MS);
    } catch {
      // never fail on cache errors
    }
    return payload;
  }

  async computeOverview() {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const trendStart = new Date(todayStart.getTime() - 6 * DAY_MS);

    const [counters, byStatus, byChannel, trend, failures] = await Promise.all([
      this.counters(now, todayStart),
      this.prisma.notificationOutbox.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.notificationOutbox.groupBy({ by: ['channel'], _count: { _all: true } }),
      this.trend(trendStart),
      this.prisma.notificationOutbox.findMany({
        where: { status: NotificationStatus.FAILED },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, channel: true, template: true, recipient: true, attempts: true, lastError: true, createdAt: true },
      }),
    ]);

    const sentToday = counters.sentToday;
    const failedToday = counters.failedToday;
    const denominator = sentToday + failedToday;

    return {
      summary: {
        total: counters.total,
        pending: counters.pending,
        sending: counters.sending,
        sent: counters.sent,
        failed: counters.failed,
        todaySuccessRatePct: denominator > 0 ? Math.round((sentToday / denominator) * 1000) / 10 : null,
        avgDeliverySec: counters.avgDeliverySec,
      },
      byStatus: byStatus.map((r) => ({ key: r.status, count: r._count._all })),
      byChannel: byChannel.map((r) => ({ key: r.channel, count: r._count._all })),
      trend,
      failures: failures.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() })),
      generatedAt: now.toISOString(),
    };
  }

  private async counters(now: Date, todayStart: Date) {
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT COUNT(*) total,
          SUM(status = 'PENDING') pending,
          SUM(status = 'PENDING' AND lockedUntil IS NOT NULL AND lockedUntil > ${now}) sending,
          SUM(status = 'SENT') sent,
          SUM(status = 'FAILED') failed,
          SUM(status = 'SENT' AND sentAt >= ${todayStart}) sentToday,
          SUM(status = 'FAILED' AND createdAt >= ${todayStart}) failedToday,
          AVG(CASE WHEN status = 'SENT' AND sentAt IS NOT NULL THEN TIMESTAMPDIFF(SECOND, createdAt, sentAt) END) avgDeliverySec
        FROM \`NotificationOutbox\`
      `);
      const r = rows[0] ?? {};
      return {
        total: num(r.total), pending: num(r.pending), sending: num(r.sending), sent: num(r.sent), failed: num(r.failed),
        sentToday: num(r.sentToday), failedToday: num(r.failedToday), avgDeliverySec: Math.round(num(r.avgDeliverySec)),
      };
    } catch (e) {
      this.logger.warn(`counters failed: ${e instanceof Error ? e.message : e}`);
      return { total: 0, pending: 0, sending: 0, sent: 0, failed: 0, sentToday: 0, failedToday: 0, avgDeliverySec: 0 };
    }
  }

  private async trend(since: Date) {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ day: unknown; sent: unknown; failed: unknown }>>(Prisma.sql`
        SELECT DATE(createdAt) day, SUM(status = 'SENT') sent, SUM(status = 'FAILED') failed
        FROM \`NotificationOutbox\` WHERE createdAt >= ${since}
        GROUP BY DATE(createdAt) ORDER BY day ASC
      `);
      return rows.map((r) => ({ day: String(r.day).slice(0, 10), sent: num(r.sent), failed: num(r.failed) }));
    } catch {
      return [];
    }
  }

  // ---------------- Paginated list ----------------

  buildWhere(query: ListNotificationCenterQuery): Prisma.NotificationOutboxWhereInput {
    const term = query.search?.trim();
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.dateFrom) createdAt.gte = query.dateFrom;
    if (query.dateTo) createdAt.lte = query.dateTo;

    const and: Prisma.NotificationOutboxWhereInput[] = [];
    if (query.order) and.push({ payload: { string_contains: query.order } });
    if (query.payment) and.push({ payload: { string_contains: query.payment } });

    return {
      channel: query.channel,
      status: query.status,
      ...(query.template ? { template: { contains: query.template } } : {}),
      ...(query.recipient ? { recipient: { contains: query.recipient } } : {}),
      ...(query.dateFrom || query.dateTo ? { createdAt } : {}),
      ...(and.length ? { AND: and } : {}),
      ...(term
        ? {
            OR: [
              { id: term },
              { recipient: { contains: term } },
              { template: { contains: term } },
              { sourceMessageId: term },
              { providerMessageId: term },
              { payload: { string_contains: term } },
            ],
          }
        : {}),
    };
  }

  async list(query: ListNotificationCenterQuery) {
    const { skip, take, page, limit } = pageArgs(query);
    const where = this.buildWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.notificationOutbox.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.notificationOutbox.count({ where }),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      channel: r.channel,
      status: r.status,
      recipient: r.recipient,
      template: r.template,
      subject: this.subjectOf(r.template, r.payload),
      attempts: r.attempts,
      sentAt: iso(r.sentAt),
      deliverySec: r.sentAt ? Math.round((r.sentAt.getTime() - r.createdAt.getTime()) / 1000) : null,
      lastError: r.lastError,
      providerMessageId: r.providerMessageId,
      related: extractRelated(r.payload),
    }));
    return paginate(items, total, page, limit);
  }

  /** Display subject via the existing renderer (null when the template is WhatsApp-only/unknown). */
  private subjectOf(template: string, payload: unknown): string | null {
    try {
      return this.renderer.render(template, (payload ?? {}) as Record<string, unknown>).subject;
    } catch {
      return null;
    }
  }

  // ---------------- Detail ----------------

  async detail(id: string) {
    const row = await this.prisma.notificationOutbox.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Notification not found');
    let rendered: { subject: string; body: string } | null = null;
    try {
      rendered = this.renderer.render(row.template, (row.payload ?? {}) as Record<string, unknown>);
    } catch {
      rendered = null;
    }
    return {
      notification: {
        ...row,
        createdAt: row.createdAt.toISOString(),
        sentAt: iso(row.sentAt),
        nextAttemptAt: iso(row.nextAttemptAt),
        lockedUntil: iso(row.lockedUntil),
        deliverySec: row.sentAt ? Math.round((row.sentAt.getTime() - row.createdAt.getTime()) / 1000) : null,
      },
      rendered,
      // Provider response surface: what the pipeline durably records per send.
      providerResponse: { providerMessageId: row.providerMessageId, lastError: row.lastError },
      retryHistory: {
        attempts: row.attempts,
        nextAttemptAt: iso(row.nextAttemptAt),
        lockedBy: row.lockedBy,
        lockedUntil: iso(row.lockedUntil),
        lastError: row.lastError,
        sentAt: iso(row.sentAt),
      },
      related: extractRelated(row.payload),
    };
  }

  // ---------------- Manual resend (delegates to the existing redrive flow) ----------------

  async resend(id: string) {
    const row = await this.prisma.notificationOutbox.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!row) throw new NotFoundException('Notification not found');
    if (row.status !== NotificationStatus.FAILED) throw new BadRequestException('Only FAILED notifications can be resent');
    // Existing recovery flow: FAILED → PENDING; the sender worker re-delivers with
    // NotificationOutbox.id as the provider idempotency key. No new retry logic.
    const result = await this.redrive.redriveFailedNotifications({ id });
    try {
      await this.cache.del(CACHE_KEY);
    } catch {
      // stale-for-≤30s is acceptable
    }
    return result;
  }
}
