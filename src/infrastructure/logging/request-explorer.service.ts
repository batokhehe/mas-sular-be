import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { pageArgs, paginate } from '../../common/pagination/pagination';
import {
  buildRequestSummary,
  buildRequestTimeline,
  relatedIds,
  RequestLogRow,
} from './request-explorer.util';

export interface ListRequestsQuery {
  page?: number;
  limit?: number;
  search?: string;
  requestId?: string;
  method?: string;
  statusCode?: number;
  path?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

/**
 * Read-only Request Explorer over existing SystemLog data. A "request" is the
 * `http/request.finished` row the request-logging middleware writes; its detail is
 * every SystemLog row sharing the same requestId (indexed lookup). Always paginated.
 */
@Injectable()
export class RequestExplorerService {
  constructor(private readonly prisma: PrismaService) {}

  async buildWhere(query: ListRequestsQuery): Promise<Prisma.SystemLogWhereInput> {
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.dateFrom) createdAt.gte = query.dateFrom;
    if (query.dateTo) createdAt.lte = query.dateTo;

    const term = query.search?.trim();
    let searchOr: Prisma.SystemLogWhereInput[] | undefined;
    if (term) {
      searchOr = [
        { requestId: term },
        { orderId: term },
        { paymentId: term },
        { shipmentId: term },
        { path: { contains: term } },
      ];
      // Customer email/name → one bounded user lookup, then filter by userId.
      const users = await this.prisma.user.findMany({
        where: { OR: [{ email: { contains: term } }, { name: { contains: term } }] },
        select: { id: true },
        take: 20,
      });
      if (users.length) searchOr.push({ userId: { in: users.map((u) => u.id) } });
    }

    return {
      // The one-per-request row (middleware) — served by the (module, createdAt) index.
      module: 'http',
      requestId: query.requestId ?? { not: null },
      method: query.method ? query.method.toUpperCase() : undefined,
      statusCode: query.statusCode,
      ...(query.path ? { path: { contains: query.path } } : {}),
      ...(query.dateFrom || query.dateTo ? { createdAt } : {}),
      ...(searchOr ? { OR: searchOr } : {}),
    };
  }

  async list(query: ListRequestsQuery) {
    const { skip, take, page, limit } = pageArgs(query);
    const where = await this.buildWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.systemLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.systemLog.count({ where }),
    ]);

    // Per-request log/error/warning counts for THIS page in ONE grouped query (no N+1).
    const ids = [...new Set(rows.map((r) => r.requestId).filter((v): v is string => !!v))];
    const counts = ids.length
      ? await this.prisma.systemLog.groupBy({ by: ['requestId', 'level'], where: { requestId: { in: ids } }, _count: { _all: true } })
      : [];
    const byRequest = new Map<string, { total: number; error: number; warn: number }>();
    for (const c of counts) {
      const key = c.requestId as string;
      const agg = byRequest.get(key) ?? { total: 0, error: 0, warn: 0 };
      agg.total += c._count._all;
      if (c.level === 'ERROR') agg.error += c._count._all;
      if (c.level === 'WARN') agg.warn += c._count._all;
      byRequest.set(key, agg);
    }

    // Resolve user/admin display names for the page in two batched queries.
    const { userById, adminById } = await this.resolveActors(rows);

    const items = rows.map((r) => {
      const agg = byRequest.get(r.requestId ?? '') ?? { total: 1, error: 0, warn: 0 };
      const finishedAt = r.createdAt;
      const startedAt = r.durationMs != null ? new Date(finishedAt.getTime() - r.durationMs) : finishedAt;
      return {
        requestId: r.requestId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: r.durationMs ?? 0,
        method: r.method,
        path: r.path,
        statusCode: r.statusCode,
        user: r.userId ? (userById.get(r.userId) ?? { id: r.userId, name: null, email: null }) : null,
        admin: r.adminId ? (adminById.get(r.adminId) ?? { id: r.adminId, name: null }) : null,
        ip: r.ip,
        totalLogs: agg.total,
        errorCount: agg.error,
        warningCount: agg.warn,
      };
    });
    return paginate(items, total, page, limit);
  }

  async detail(requestId: string) {
    const rows = (await this.prisma.systemLog.findMany({
      where: { requestId },
      orderBy: { createdAt: 'asc' },
    })) as unknown as RequestLogRow[];
    if (rows.length === 0) throw new NotFoundException('Request not found');

    const summary = buildRequestSummary(rows);
    const { userById, adminById } = await this.resolveActors(rows);

    return {
      summary: {
        ...summary,
        user: summary.userId ? (userById.get(summary.userId) ?? { id: summary.userId, name: null, email: null }) : null,
        admin: summary.adminId ? (adminById.get(summary.adminId) ?? { id: summary.adminId, name: null }) : null,
      },
      timeline: buildRequestTimeline(rows),
      related: relatedIds(rows),
    };
  }

  /** Batch-resolve actor display names (one users query + one admins query max). */
  private async resolveActors(rows: Array<{ userId: string | null; adminId: string | null }>) {
    const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))];
    const adminIds = [...new Set(rows.map((r) => r.adminId).filter((v): v is string => !!v))];
    const [users, admins] = await Promise.all([
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
      adminIds.length ? this.prisma.admin.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } }) : [],
    ]);
    return {
      userById: new Map(users.map((u) => [u.id, u])),
      adminById: new Map(admins.map((a) => [a.id, a])),
    };
  }
}
