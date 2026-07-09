import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { IncidentSeverity, IncidentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { pageArgs, paginate } from '../../common/pagination/pagination';
import { dbPerfRegistry } from './db-perf.registry';
import { percentile } from './performance-profiler.util';
import {
  evaluateRules,
  IncidentCandidate,
  IncidentSignals,
  IncidentThresholds,
  loadIncidentThresholds,
} from './incident.rules';

const SWEEP_GATE_KEY = 'admin:incidents:last-sweep';
const SWEEP_TTL_MS = 30_000;
const HOUR_MS = 60 * 60 * 1000;
const ACTIVE: IncidentStatus[] = [IncidentStatus.OPEN, IncidentStatus.ACKNOWLEDGED];

function num(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (v === null || v === undefined) return 0;
  return Number(v);
}

export interface ListIncidentsQuery {
  page?: number;
  limit?: number;
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  source?: string;
  worker?: string;
  module?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

/**
 * Incident Center — auto-detects operational incidents from EXISTING signals
 * (SystemLog, queue tables, Redis ping, DB timing registry) and manages their
 * lifecycle (OPEN → ACKNOWLEDGED → RESOLVED). Detection is a 30s-throttled sweep
 * that deduplicates by `type` while an incident is still active (count/lastSeen
 * bump instead of duplicates). Never touches business flows.
 */
@Injectable()
export class IncidentCenterService {
  private readonly logger = new Logger('IncidentCenterService');
  private readonly thresholds: IncidentThresholds = loadIncidentThresholds();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ---------------- List + summary (runs the throttled sweep first) ----------------

  async list(query: ListIncidentsQuery) {
    await this.sweepIfDue();
    const { skip, take, page, limit } = pageArgs(query);
    const where = this.buildWhere(query);
    const [items, total, summary] = await Promise.all([
      this.prisma.incident.findMany({ where, orderBy: { lastSeen: 'desc' }, skip, take }),
      this.prisma.incident.count({ where }),
      this.summary(),
    ]);
    return { ...paginate(items, total, page, limit), summary };
  }

  buildWhere(query: ListIncidentsQuery): Prisma.IncidentWhereInput {
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.dateFrom) createdAt.gte = query.dateFrom;
    if (query.dateTo) createdAt.lte = query.dateTo;
    return {
      status: query.status,
      severity: query.severity,
      source: query.source,
      worker: query.worker,
      module: query.module,
      ...(query.dateFrom || query.dateTo ? { createdAt } : {}),
    };
  }

  private async summary() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [open, critical, high, acknowledged, resolvedToday] = await Promise.all([
      this.prisma.incident.count({ where: { status: IncidentStatus.OPEN } }),
      this.prisma.incident.count({ where: { status: { in: ACTIVE }, severity: IncidentSeverity.CRITICAL } }),
      this.prisma.incident.count({ where: { status: { in: ACTIVE }, severity: IncidentSeverity.HIGH } }),
      this.prisma.incident.count({ where: { status: IncidentStatus.ACKNOWLEDGED } }),
      this.prisma.incident.count({ where: { status: IncidentStatus.RESOLVED, resolvedAt: { gte: todayStart } } }),
    ]);
    return { open, critical, high, acknowledged, resolvedToday };
  }

  // ---------------- Detail (incident + correlated SystemLog timeline) ----------------

  async detail(id: string) {
    const incident = await this.prisma.incident.findUnique({ where: { id } });
    if (!incident) throw new NotFoundException('Incident not found');

    const or: Prisma.SystemLogWhereInput[] = [];
    if (incident.module) or.push({ module: incident.module });
    if (incident.requestId) or.push({ requestId: incident.requestId });
    const timeline = or.length
      ? await this.prisma.systemLog.findMany({
          where: { OR: or, createdAt: { gte: incident.firstSeen } },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { id: true, createdAt: true, level: true, module: true, action: true, message: true, durationMs: true, statusCode: true },
        })
      : [];
    return { incident, timeline };
  }

  // ---------------- Lifecycle (CAS transitions) ----------------

  async acknowledge(id: string, adminId: string) {
    const flip = await this.prisma.incident.updateMany({
      where: { id, status: IncidentStatus.OPEN },
      data: { status: IncidentStatus.ACKNOWLEDGED, acknowledgedAt: new Date(), acknowledgedBy: adminId },
    });
    if (flip.count !== 1) {
      const exists = await this.prisma.incident.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundException('Incident not found');
      throw new ConflictException('Only OPEN incidents can be acknowledged');
    }
    return this.prisma.incident.findUniqueOrThrow({ where: { id } });
  }

  async resolve(id: string, adminId: string) {
    const flip = await this.prisma.incident.updateMany({
      where: { id, status: { in: ACTIVE } },
      data: { status: IncidentStatus.RESOLVED, resolvedAt: new Date(), resolvedBy: adminId },
    });
    if (flip.count !== 1) {
      const exists = await this.prisma.incident.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundException('Incident not found');
      throw new ConflictException('Incident is already resolved');
    }
    return this.prisma.incident.findUniqueOrThrow({ where: { id } });
  }

  // ---------------- Detection sweep (30s-throttled via the cache) ----------------

  /** Run detection at most once per 30s across callers. Never throws. */
  async sweepIfDue(): Promise<boolean> {
    try {
      if (await this.cache.get(SWEEP_GATE_KEY)) return false;
      await this.cache.set(SWEEP_GATE_KEY, Date.now(), SWEEP_TTL_MS);
    } catch {
      // cache unavailable → still sweep (redis-down detection must be able to fire)
    }
    try {
      await this.detectAndUpsert();
      return true;
    } catch (err) {
      this.logger.warn(`incident sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Gather signals → evaluate rules → dedup-upsert incidents. */
  async detectAndUpsert(): Promise<number> {
    const signals = await this.gatherSignals();
    const candidates = evaluateRules(signals, this.thresholds);
    for (const candidate of candidates) {
      await this.upsertIncident(candidate);
    }
    return candidates.length;
  }

  private async upsertIncident(candidate: IncidentCandidate): Promise<void> {
    const existing = await this.prisma.incident.findFirst({
      where: { type: candidate.type, status: { in: ACTIVE } },
      select: { id: true, severity: true },
    });
    const now = new Date();
    if (existing) {
      // Still firing: bump count/lastSeen; escalate severity but never de-escalate.
      const escalate = severityRank(candidate.severity) > severityRank(existing.severity);
      await this.prisma.incident.update({
        where: { id: existing.id },
        data: {
          count: { increment: 1 },
          lastSeen: now,
          ...(escalate ? { severity: candidate.severity } : {}),
          title: candidate.title,
          description: candidate.description,
          metadata: (candidate.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      return;
    }
    await this.prisma.incident.create({
      data: {
        type: candidate.type,
        severity: candidate.severity,
        title: candidate.title,
        description: candidate.description,
        source: candidate.source,
        worker: candidate.worker ?? null,
        module: candidate.module ?? null,
        firstSeen: now,
        lastSeen: now,
        metadata: (candidate.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  private async gatherSignals(): Promise<IncidentSignals> {
    const since = new Date(Date.now() - HOUR_MS);
    const [requests, workers, outbox, notifications, redisConnected, checkoutP95Ms] = await Promise.all([
      this.requestSignals(since),
      this.workerSignals(since),
      this.outboxSignals(),
      this.notificationSignals(),
      this.redisPing(),
      this.checkoutP95(since),
    ]);
    const dbSnap = dbPerfRegistry.snapshot(1);
    return {
      requests,
      workers,
      outbox,
      notifications,
      redisConnected,
      rabbitConfigured: !!process.env.RABBITMQ_URL,
      checkoutP95Ms,
      dbWorst: dbSnap.queries[0] ? { name: dbSnap.queries[0].name, avgMs: dbSnap.queries[0].avgMs, count: dbSnap.queries[0].count } : null,
    };
  }

  private async requestSignals(since: Date) {
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT COUNT(*) count, SUM(statusCode >= 500) errors FROM \`SystemLog\`
        WHERE module = 'http' AND createdAt >= ${since}
      `);
      return { count: num(rows[0]?.count), errors: num(rows[0]?.errors) };
    } catch {
      return { count: 0, errors: 0 };
    }
  }

  private async workerSignals(since: Date) {
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT module,
          SUM(action = 'tick.failed') failures,
          MAX(CASE WHEN action = 'tick.failed' THEN createdAt END) lastFailure,
          MAX(CASE WHEN action = 'tick' THEN createdAt END) lastSuccess
        FROM \`SystemLog\` WHERE module LIKE 'worker.%' AND createdAt >= ${since} GROUP BY module
      `);
      return rows.map((r) => ({
        key: String(r.module).slice('worker.'.length),
        failures: num(r.failures),
        lastFailure: r.lastFailure ? new Date(r.lastFailure as string).toISOString() : null,
        lastSuccess: r.lastSuccess ? new Date(r.lastSuccess as string).toISOString() : null,
      }));
    } catch {
      return [];
    }
  }

  private async outboxSignals() {
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT SUM(status = 'PENDING') pending, SUM(status = 'FAILED') failed,
               MIN(CASE WHEN status = 'PENDING' THEN createdAt END) oldestPending
        FROM \`OutboxEvent\`
      `);
      const oldest = rows[0]?.oldestPending ? new Date(rows[0].oldestPending as string) : null;
      return { pending: num(rows[0]?.pending), failed: num(rows[0]?.failed), oldestPendingAgeMs: oldest ? Date.now() - oldest.getTime() : null };
    } catch {
      return { pending: 0, failed: 0, oldestPendingAgeMs: null };
    }
  }

  private async notificationSignals() {
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT SUM(status = 'PENDING') pending, SUM(status = 'FAILED') failed FROM \`NotificationOutbox\`
      `);
      return { pending: num(rows[0]?.pending), failed: num(rows[0]?.failed) };
    } catch {
      return { pending: 0, failed: 0 };
    }
  }

  private async redisPing(): Promise<boolean> {
    try {
      await this.cache.set('incidents:ping', 'ok', 5_000);
      return (await this.cache.get<string>('incidents:ping')) === 'ok';
    } catch {
      return false;
    }
  }

  private async checkoutP95(since: Date): Promise<number> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ d: unknown }>>(Prisma.sql`
        SELECT durationMs d FROM \`SystemLog\`
        WHERE module = 'http' AND method = 'POST' AND path LIKE '%/checkout/order'
          AND durationMs IS NOT NULL AND createdAt >= ${since}
        ORDER BY durationMs ASC LIMIT 5000
      `);
      return percentile(rows.map((r) => num(r.d)), 95);
    } catch {
      return 0;
    }
  }
}

const SEVERITY_ORDER: IncidentSeverity[] = [IncidentSeverity.INFO, IncidentSeverity.LOW, IncidentSeverity.MEDIUM, IncidentSeverity.HIGH, IncidentSeverity.CRITICAL];
function severityRank(s: IncidentSeverity): number {
  return SEVERITY_ORDER.indexOf(s);
}
