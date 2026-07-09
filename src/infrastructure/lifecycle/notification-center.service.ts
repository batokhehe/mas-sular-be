import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { NotificationChannel, NotificationOutbox, NotificationStatus, Prisma } from '@prisma/client';
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
  provider?: string;
  hasError?: boolean;
  retryMin?: number;
  durationMin?: number;
  durationMax?: number;
}

/** Provider → channel mapping (one provider per channel today; PUSH/SMS have none yet). */
export const PROVIDER_CHANNEL: Record<string, NotificationChannel> = {
  QONTAK: NotificationChannel.WHATSAPP,
  RESEND: NotificationChannel.EMAIL,
};

const BULK_RESEND_MAX = 100;

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

    const [counters, byStatus, byChannel, trend, byHour, failures] = await Promise.all([
      this.counters(now, todayStart),
      this.prisma.notificationOutbox.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.notificationOutbox.groupBy({ by: ['channel'], _count: { _all: true } }),
      this.trend(trendStart),
      this.byHour(now),
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
        retriedToday: counters.retriedToday,
      },
      byStatus: byStatus.map((r) => ({ key: r.status, count: r._count._all })),
      byChannel: byChannel.map((r) => ({ key: r.channel, count: r._count._all })),
      trend,
      byHour,
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
          SUM(attempts > 1 AND (sentAt >= ${todayStart} OR nextAttemptAt >= ${todayStart})) retriedToday,
          AVG(CASE WHEN status = 'SENT' AND sentAt IS NOT NULL THEN TIMESTAMPDIFF(SECOND, createdAt, sentAt) END) avgDeliverySec
        FROM \`NotificationOutbox\`
      `);
      const r = rows[0] ?? {};
      return {
        total: num(r.total), pending: num(r.pending), sending: num(r.sending), sent: num(r.sent), failed: num(r.failed),
        sentToday: num(r.sentToday), failedToday: num(r.failedToday), retriedToday: num(r.retriedToday),
        avgDeliverySec: Math.round(num(r.avgDeliverySec)),
      };
    } catch (e) {
      this.logger.warn(`counters failed: ${e instanceof Error ? e.message : e}`);
      return { total: 0, pending: 0, sending: 0, sent: 0, failed: 0, sentToday: 0, failedToday: 0, retriedToday: 0, avgDeliverySec: 0 };
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

  /** Last-24h volume per hour. Buckets on epoch hours (timezone-proof) and zero-fills gaps. */
  private async byHour(now: Date) {
    const HOUR_MS = 60 * 60 * 1000;
    const currentBucket = Math.floor(now.getTime() / HOUR_MS);
    const since = new Date((currentBucket - 23) * HOUR_MS);
    try {
      const rows = await this.prisma.$queryRaw<Array<{ bucket: unknown; total: unknown; sent: unknown; failed: unknown }>>(Prisma.sql`
        SELECT UNIX_TIMESTAMP(createdAt) DIV 3600 bucket, COUNT(*) total, SUM(status = 'SENT') sent, SUM(status = 'FAILED') failed
        FROM \`NotificationOutbox\` WHERE createdAt >= ${since}
        GROUP BY bucket ORDER BY bucket ASC
      `);
      const byBucket = new Map(rows.map((r) => [num(r.bucket), r]));
      return Array.from({ length: 24 }, (_, i) => {
        const bucket = currentBucket - 23 + i;
        const r = byBucket.get(bucket);
        return {
          hour: new Date(bucket * HOUR_MS).toISOString(),
          total: r ? num(r.total) : 0,
          sent: r ? num(r.sent) : 0,
          failed: r ? num(r.failed) : 0,
        };
      });
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
    // Provider filter maps onto the channel that provider serves (ANDed so it
    // cannot widen an explicit channel filter).
    const providerChannel = query.provider ? PROVIDER_CHANNEL[query.provider.toUpperCase()] : undefined;
    if (query.provider) and.push({ channel: providerChannel ?? { in: [] } });
    if (query.hasError === true) and.push({ lastError: { not: null } });
    if (query.hasError === false) and.push({ lastError: null });
    if (query.retryMin !== undefined) and.push({ attempts: { gte: query.retryMin } });

    return {
      channel: query.channel,
      status: query.status,
      ...(query.template ? { template: { contains: query.template } } : {}),
      ...(query.recipient ? { recipient: { contains: query.recipient } } : {}),
      ...(query.dateFrom || query.dateTo ? { createdAt } : {}),
      ...(and.length ? { AND: and } : {}),
      ...(term
        ? {
            // Covers: notification id, recipient (phone/email), order number /
            // payment id (payload substring), source & provider message ids.
            OR: [
              { id: term },
              { recipient: { contains: term } },
              { template: { contains: term } },
              { sourceMessageId: term },
              { providerMessageId: { contains: term } },
              { payload: { string_contains: term } },
            ],
          }
        : {}),
    };
  }

  async list(query: ListNotificationCenterQuery) {
    const { skip, take, page, limit } = pageArgs(query);
    const where = this.buildWhere(query);
    const hasDuration = query.durationMin !== undefined || query.durationMax !== undefined;
    const [rows, total] = hasDuration
      ? await this.listWithDurationFilter(query, skip, take)
      : await Promise.all([
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

  /**
   * Duration is a derived column (sentAt − createdAt) that Prisma cannot filter on,
   * so this path mirrors buildWhere in SQL, selects ONE page of ids + a count, then
   * hydrates the page through Prisma. Three bounded queries — page-size independent
   * of row count, never per-row.
   */
  private async listWithDurationFilter(
    query: ListNotificationCenterQuery,
    skip: number,
    take: number,
  ): Promise<[NotificationOutbox[], number]> {
    const cond = this.sqlWhere(query);
    const [idRows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM \`NotificationOutbox\` WHERE ${cond} ORDER BY createdAt DESC LIMIT ${take} OFFSET ${skip}`,
      ),
      this.prisma.$queryRaw<Array<{ c: unknown }>>(Prisma.sql`SELECT COUNT(*) c FROM \`NotificationOutbox\` WHERE ${cond}`),
    ]);
    const ids = idRows.map((r) => r.id);
    const rows = ids.length ? await this.prisma.notificationOutbox.findMany({ where: { id: { in: ids } } }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
    return [ordered, num(countRows[0]?.c)];
  }

  /** SQL mirror of buildWhere (used only when a duration filter is active). */
  private sqlWhere(query: ListNotificationCenterQuery): Prisma.Sql {
    const like = (s: string) => `%${s}%`;
    const conds: Prisma.Sql[] = [Prisma.sql`1 = 1`];
    if (query.channel) conds.push(Prisma.sql`channel = ${query.channel}`);
    if (query.provider) {
      const providerChannel = PROVIDER_CHANNEL[query.provider.toUpperCase()];
      conds.push(providerChannel ? Prisma.sql`channel = ${providerChannel}` : Prisma.sql`1 = 0`);
    }
    if (query.status) conds.push(Prisma.sql`status = ${query.status}`);
    if (query.template) conds.push(Prisma.sql`template LIKE ${like(query.template)}`);
    if (query.recipient) conds.push(Prisma.sql`recipient LIKE ${like(query.recipient)}`);
    if (query.dateFrom) conds.push(Prisma.sql`createdAt >= ${query.dateFrom}`);
    if (query.dateTo) conds.push(Prisma.sql`createdAt <= ${query.dateTo}`);
    if (query.order) conds.push(Prisma.sql`CAST(payload AS CHAR) LIKE ${like(query.order)}`);
    if (query.payment) conds.push(Prisma.sql`CAST(payload AS CHAR) LIKE ${like(query.payment)}`);
    if (query.hasError === true) conds.push(Prisma.sql`lastError IS NOT NULL`);
    if (query.hasError === false) conds.push(Prisma.sql`lastError IS NULL`);
    if (query.retryMin !== undefined) conds.push(Prisma.sql`attempts >= ${query.retryMin}`);
    if (query.durationMin !== undefined)
      conds.push(Prisma.sql`sentAt IS NOT NULL AND TIMESTAMPDIFF(SECOND, createdAt, sentAt) >= ${query.durationMin}`);
    if (query.durationMax !== undefined)
      conds.push(Prisma.sql`sentAt IS NOT NULL AND TIMESTAMPDIFF(SECOND, createdAt, sentAt) <= ${query.durationMax}`);
    const term = query.search?.trim();
    if (term)
      conds.push(
        Prisma.sql`(id = ${term} OR recipient LIKE ${like(term)} OR template LIKE ${like(term)} OR sourceMessageId = ${term} OR providerMessageId LIKE ${like(term)} OR CAST(payload AS CHAR) LIKE ${like(term)})`,
      );
    return Prisma.join(conds, ' AND ');
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
    await this.stampResend([id]);
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

  /**
   * Bulk resend for the admin multi-select. One `id IN (...)` redrive batch; the
   * `status='FAILED'` guard inside RedriveService silently skips non-FAILED ids,
   * so callers get back how many actually re-queued.
   */
  async bulkResend(ids: string[]) {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) throw new BadRequestException('No notification ids provided');
    if (unique.length > BULK_RESEND_MAX) throw new BadRequestException(`At most ${BULK_RESEND_MAX} notifications per bulk resend`);
    await this.stampResend(unique);
    const result = await this.redrive.redriveFailedNotifications({ ids: unique });
    try {
      await this.cache.del(CACHE_KEY);
    } catch {
      // stale-for-≤30s is acceptable
    }
    return { requested: unique.length, redriven: result.redriven, skipped: unique.length - result.redriven };
  }

  /**
   * Best-effort marker for the Communication Center's "Resend" history badge:
   * stamps payload.resendAt on the FAILED rows about to be redriven. Rendering
   * ignores unknown payload keys, and a stamp failure never blocks the resend.
   */
  private async stampResend(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE \`NotificationOutbox\`
        SET payload = JSON_SET(payload, '$.resendAt', ${new Date().toISOString()})
        WHERE status = 'FAILED' AND id IN (${Prisma.join(ids)})
      `);
    } catch (e) {
      this.logger.warn(`resend stamp failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
