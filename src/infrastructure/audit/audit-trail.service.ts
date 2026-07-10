import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { PrismaService } from '../../database/prisma.service';
import { pageArgs, paginate } from '../../common/pagination/pagination';
import { computeDiff, deriveEntityName, sanitizeSnapshot } from './audit-diff.util';
import { numOrZero as num } from '../../common/utils/number.util';

const EXPORT_BATCH = 1000;
const EXPORT_MAX_ROWS = 50_000;

export interface AuditRecordInput {
  adminId?: string | null;
  adminName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  module: string;
  entity: string;
  entityId?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown> | null;
  success: boolean;
}

export interface ListAuditQuery {
  page?: number;
  limit?: number;
  module?: string;
  action?: string;
  admin?: string; // adminId or name contains
  entity?: string;
  entityId?: string;
  success?: boolean;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

/**
 * Enterprise Audit Trail — records HUMAN admin actions (with before/after/diff),
 * serves the filtered list + per-entity timeline, and streams CSV exports.
 * Recording is fire-and-forget: an audit failure can never break the action.
 */
@Injectable()
export class AuditTrailService {
  private readonly logger = new Logger('AuditTrailService');

  constructor(private readonly prisma: PrismaService) {}

  // ---------------- Recording (fire-and-forget) ----------------

  record(input: AuditRecordInput): void {
    void this.persist(input).catch((err) => this.logger.warn(`audit record failed: ${err instanceof Error ? err.message : err}`));
  }

  private async persist(input: AuditRecordInput): Promise<void> {
    const before = input.before != null ? sanitizeSnapshot(input.before) : null;
    const after = input.after != null ? sanitizeSnapshot(input.after) : null;
    const diff = computeDiff(before, after);
    await this.prisma.auditTrail.create({
      data: {
        adminId: input.adminId ?? null,
        adminName: input.adminName?.slice(0, 255) ?? null,
        ipAddress: input.ipAddress?.slice(0, 64) ?? null,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
        requestId: input.requestId ?? null,
        module: input.module.slice(0, 64),
        entity: input.entity.slice(0, 64),
        entityId: input.entityId?.slice(0, 64) ?? null,
        entityName: deriveEntityName(after ?? before),
        action: input.action.slice(0, 48),
        before: (before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (after ?? undefined) as Prisma.InputJsonValue | undefined,
        diff: diff.length ? (diff as unknown as Prisma.InputJsonValue) : undefined,
        metadata: input.metadata ? (sanitizeSnapshot(input.metadata) as Prisma.InputJsonValue) : undefined,
        success: input.success,
      },
    });
  }

  // ---------------- List + summary ----------------

  buildWhere(query: ListAuditQuery): Prisma.AuditTrailWhereInput {
    const term = query.search?.trim();
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.dateFrom) createdAt.gte = query.dateFrom;
    if (query.dateTo) createdAt.lte = query.dateTo;
    return {
      module: query.module,
      action: query.action,
      entity: query.entity,
      entityId: query.entityId,
      success: query.success,
      ...(query.admin ? { OR: [{ adminId: query.admin }, { adminName: { contains: query.admin } }] } : {}),
      ...(query.dateFrom || query.dateTo ? { createdAt } : {}),
      ...(term
        ? {
            AND: [
              {
                OR: [
                  { entityId: term },
                  { entityName: { contains: term } },
                  { requestId: term },
                  { adminName: { contains: term } },
                  { action: { contains: term.toUpperCase() } },
                ],
              },
            ],
          }
        : {}),
    };
  }

  async list(query: ListAuditQuery) {
    const { skip, take, page, limit } = pageArgs(query);
    const where = this.buildWhere(query);
    const [items, total, summary] = await Promise.all([
      this.prisma.auditTrail.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.auditTrail.count({ where }),
      this.summary(),
    ]);
    return { ...paginate(items, total, page, limit), summary };
  }

  private async summary() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT COUNT(*) total, SUM(success = 1) ok, SUM(success = 0) failed, COUNT(DISTINCT adminId) admins
        FROM \`AuditTrail\` WHERE createdAt >= ${todayStart}
      `);
      const r = rows[0] ?? {};
      return { todayChanges: num(r.total), successful: num(r.ok), failed: num(r.failed), uniqueAdmins: num(r.admins) };
    } catch {
      return { todayChanges: 0, successful: 0, failed: 0, uniqueAdmins: 0 };
    }
  }

  // ---------------- Detail + per-entity timeline ----------------

  async detail(id: string) {
    const entry = await this.prisma.auditTrail.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException('Audit entry not found');

    let previous = null;
    let next = null;
    let timeline: Array<{ id: string; action: string; adminName: string | null; createdAt: Date; success: boolean }> = [];
    if (entry.entityId) {
      const entityWhere = { entity: entry.entity, entityId: entry.entityId };
      [previous, next, timeline] = await Promise.all([
        this.prisma.auditTrail.findFirst({
          where: { ...entityWhere, createdAt: { lt: entry.createdAt }, id: { not: entry.id } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, action: true, adminName: true, createdAt: true, success: true },
        }),
        this.prisma.auditTrail.findFirst({
          where: { ...entityWhere, createdAt: { gt: entry.createdAt }, id: { not: entry.id } },
          orderBy: { createdAt: 'asc' },
          select: { id: true, action: true, adminName: true, createdAt: true, success: true },
        }),
        this.prisma.auditTrail.findMany({
          where: entityWhere,
          orderBy: { createdAt: 'asc' },
          take: 20,
          select: { id: true, action: true, adminName: true, createdAt: true, success: true },
        }),
      ]);
    }
    return { entry, previous, next, timeline };
  }

  // ---------------- CSV export (streamed in batches) ----------------

  async exportCsv(query: ListAuditQuery, res: Response): Promise<void> {
    const where = this.buildWhere(query);

    // ML-2: a cancelled download must stop the export immediately — no further
    // batch reads, row generation, or writes into a dead socket. `close` fires on
    // client abort before `destroyed` is observable in all Express versions, so
    // track both. Never throws: an aborted export just returns.
    let aborted = false;
    res.req?.on('close', () => {
      aborted = true;
    });
    const clientGone = (): boolean => aborted || res.destroyed || res.writableEnded;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-trail-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write('id,createdAt,admin,module,entity,entityId,entityName,action,success,changedFields,requestId,ip\n');

    const esc = (v: unknown): string => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    let cursor: string | undefined;
    let exported = 0;
    while (exported < EXPORT_MAX_ROWS) {
      if (clientGone()) return; // stop BEFORE the next database read
      const rows = await this.prisma.auditTrail.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: EXPORT_BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        if (clientGone()) return; // stop generating/writing mid-batch too
        const changed = Array.isArray(r.diff) ? (r.diff as unknown[]).length : 0;
        try {
          res.write(
            [r.id, r.createdAt.toISOString(), r.adminName ?? r.adminId ?? 'system', r.module, r.entity, r.entityId ?? '', r.entityName ?? '', r.action, r.success ? 'success' : 'failed', changed, r.requestId ?? '', r.ipAddress ?? '']
              .map(esc)
              .join(',') + '\n',
          );
        } catch {
          return; // socket died mid-write — give up gracefully
        }
      }
      exported += rows.length;
      cursor = rows[rows.length - 1].id;
      if (rows.length < EXPORT_BATCH) break;
    }
    if (!clientGone()) res.end();
  }
}
