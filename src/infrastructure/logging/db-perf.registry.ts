/**
 * In-memory database timing registry, fed by Prisma query EVENTS (see
 * PrismaService). Only AGGREGATES keyed by a derived query name are kept —
 * raw SQL and parameters are NEVER stored or logged. Zero I/O; bounded size.
 */

export const SLOW_DB_MS = 200;
const MAX_KEYS = 200;
const OVERFLOW_KEY = 'OTHER';

/** Derive a safe query name (VERB Table) from SQL. The SQL itself is discarded. */
export function queryNameFromSql(sql: string): string {
  const s = (sql ?? '').trim();
  const verb = (s.match(/^[a-zA-Z]+/)?.[0] ?? 'QUERY').toUpperCase();
  // Prefer the table after FROM/INTO/UPDATE; Prisma quotes `db`.`Table`.
  const target =
    s.match(/(?:FROM|INTO|UPDATE)\s+`(?:[^`]+`\.`)?([^`]+)`/i)?.[1] ??
    s.match(/`(?:[^`]+`\.`)?([^`]+)`/)?.[1] ??
    null;
  return target ? `${verb} ${target}` : verb;
}

export interface DbQueryStat {
  name: string;
  count: number;
  avgMs: number;
  maxMs: number;
  slowCount: number;
}

interface Agg {
  count: number;
  totalMs: number;
  maxMs: number;
  slowCount: number;
}

export class DbPerfRegistry {
  private byName = new Map<string, Agg>();
  private windowStartedAt = new Date();

  record(name: string, durationMs: number): void {
    const key = this.byName.has(name) || this.byName.size < MAX_KEYS ? name : OVERFLOW_KEY;
    const agg = this.byName.get(key) ?? { count: 0, totalMs: 0, maxMs: 0, slowCount: 0 };
    agg.count += 1;
    agg.totalMs += durationMs;
    if (durationMs > agg.maxMs) agg.maxMs = durationMs;
    if (durationMs >= SLOW_DB_MS) agg.slowCount += 1;
    this.byName.set(key, agg);
  }

  /** Top-N by average duration + the total slow-call count for the summary card. */
  snapshot(top = 20): { since: string; totalQueries: number; slowCount: number; queries: DbQueryStat[] } {
    const queries = [...this.byName.entries()]
      .map(([name, a]) => ({ name, count: a.count, avgMs: Math.round(a.totalMs / a.count), maxMs: Math.round(a.maxMs), slowCount: a.slowCount }))
      .sort((a, b) => b.avgMs - a.avgMs)
      .slice(0, top);
    let totalQueries = 0;
    let slowCount = 0;
    for (const a of this.byName.values()) {
      totalQueries += a.count;
      slowCount += a.slowCount;
    }
    return { since: this.windowStartedAt.toISOString(), totalQueries, slowCount, queries };
  }
}

/** Process-wide singleton (PrismaService writes; the profiler reads). */
export const dbPerfRegistry = new DbPerfRegistry();
