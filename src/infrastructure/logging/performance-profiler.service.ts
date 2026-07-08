import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { dbPerfRegistry } from './db-perf.registry';
import {
  PerfRow,
  profileRequests,
  profileWorkers,
  rankEndpoints,
  rankModules,
} from './performance-profiler.util';

export type PerfRange = '1h' | '24h' | '7d' | '30d';

const HOUR = 60 * 60 * 1000;
export const PERF_RANGES: Record<PerfRange, { ms: number; bucketMs: number }> = {
  '1h': { ms: HOUR, bucketMs: 5 * 60 * 1000 },
  '24h': { ms: 24 * HOUR, bucketMs: HOUR },
  '7d': { ms: 7 * 24 * HOUR, bucketMs: 6 * HOUR },
  '30d': { ms: 30 * 24 * HOUR, bucketMs: 24 * HOUR },
};

const CACHE_TTL_MS = 30_000;
const MAX_ROWS = 50_000; // hard bound on the in-memory profiling set

/**
 * Performance Profiler — read-only aggregation over SystemLog durations (requests
 * + worker ticks), the in-memory DB timing registry, and Redis stats. ONE bounded
 * fetch per range; all percentiles/ranking are pure in-memory functions. 30s cache
 * per range. Never mutates state.
 */
@Injectable()
export class PerformanceProfilerService {
  private readonly logger = new Logger('PerformanceProfilerService');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async profile(range: PerfRange = '24h') {
    const key = `admin:performance:${range}`;
    try {
      const cached = await this.cache.get<Awaited<ReturnType<PerformanceProfilerService['compute']>>>(key);
      if (cached) return cached;
    } catch {
      // cache unavailable → compute
    }
    const payload = await this.compute(range);
    try {
      await this.cache.set(key, payload, CACHE_TTL_MS);
    } catch {
      // never fail on cache errors
    }
    return payload;
  }

  async compute(range: PerfRange) {
    const now = new Date();
    const { ms, bucketMs } = PERF_RANGES[range] ?? PERF_RANGES['24h'];
    const since = new Date(now.getTime() - ms);

    const [rows, cacheMetrics] = await Promise.all([this.fetchRows(since), this.cacheMetrics()]);

    const requests = profileRequests(rows, bucketMs);
    const endpoints = rankEndpoints(rows, 20);
    const modules = rankModules(rows);
    const workers = profileWorkers(rows);
    const database = dbPerfRegistry.snapshot(20);

    return {
      summary: {
        avgResponseMs: requests.avgMs,
        p95: requests.p95,
        p99: requests.p99,
        slowRequests: requests.slowCount,
        slowWorkers: workers.slowCount,
        slowDbCalls: database.slowCount,
        cacheHitRate: cacheMetrics.hitRate,
      },
      requests,
      endpoints,
      modules,
      database,
      workers,
      cache: cacheMetrics,
      range,
      generatedAt: now.toISOString(),
    };
  }

  /** ONE bounded query powers requests + endpoints + modules + workers (no N+1). */
  private async fetchRows(since: Date): Promise<PerfRow[]> {
    try {
      const rows = await this.prisma.$queryRaw<Array<PerfRow & { durationMs: unknown }>>(Prisma.sql`
        SELECT module, action, method, path, statusCode, durationMs, createdAt
        FROM \`SystemLog\`
        WHERE durationMs IS NOT NULL AND createdAt >= ${since}
        ORDER BY createdAt DESC
        LIMIT ${MAX_ROWS}
      `);
      return rows.map((r) => ({ ...r, durationMs: Number(r.durationMs), createdAt: new Date(r.createdAt) }));
    } catch (e) {
      this.logger.warn(`fetchRows failed: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Timed Redis ping + server-wide hit/miss from INFO stats (graceful fallback). */
  private async cacheMetrics() {
    const startedAt = Date.now();
    let connected = false;
    try {
      await this.cache.set('performance:ping', 'ok', 5_000);
      connected = (await this.cache.get<string>('performance:ping')) === 'ok';
    } catch {
      connected = false;
    }
    const latencyMs = Date.now() - startedAt;

    let hits: number | null = null;
    let misses: number | null = null;
    try {
      const client = (this.cache as unknown as { store?: { client?: { info?: (section: string) => Promise<string> } } }).store?.client;
      if (connected && client?.info) {
        const stats = await client.info('stats');
        hits = Number(stats.match(/keyspace_hits:(\d+)/)?.[1] ?? NaN);
        misses = Number(stats.match(/keyspace_misses:(\d+)/)?.[1] ?? NaN);
        if (!Number.isFinite(hits)) hits = null;
        if (!Number.isFinite(misses)) misses = null;
      }
    } catch {
      hits = null;
      misses = null;
    }
    const total = (hits ?? 0) + (misses ?? 0);
    const hitRate = hits != null && misses != null && total > 0 ? Math.round((hits / total) * 1000) / 10 : null;
    return { connected, latencyMs, hits, misses, hitRate, lastPing: new Date().toISOString() };
  }
}
