import { ForbiddenException } from '@nestjs/common';
import {
  percentile, normalizeEndpoint, profileRequests, rankEndpoints, rankModules, profileWorkers, PerfRow,
} from '../../src/infrastructure/logging/performance-profiler.util';
import { DbPerfRegistry, queryNameFromSql } from '../../src/infrastructure/logging/db-perf.registry';
import { PerformanceProfilerService } from '../../src/infrastructure/logging/performance-profiler.service';
import { PermissionGuard } from '../../src/common/guards/permission.guard';

const T0 = new Date('2026-07-07T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function row(over: Partial<PerfRow> = {}): PerfRow {
  return { module: 'http', action: 'request.finished', method: 'GET', path: '/api/v1/products', statusCode: 200, durationMs: 100, createdAt: T0, ...over };
}

describe('percentiles', () => {
  it('nearest-rank: p50/p95/p99 on a known distribution', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 95)).toBe(0);
  });
});

describe('request aggregation', () => {
  const rows: PerfRow[] = [
    row({ durationMs: 100, createdAt: at(0) }),
    row({ durationMs: 300, createdAt: at(10) }),
    row({ durationMs: 1500, createdAt: at(70) }), // slow (>= 1000ms), next hour bucket
    row({ module: 'worker.retention', action: 'tick', durationMs: 50, createdAt: at(5) }), // ignored (not http)
  ];

  it('computes avg/p50/p95/p99 + slow count over http rows only', () => {
    const p = profileRequests(rows, 60 * 60 * 1000);
    expect(p.count).toBe(3);
    expect(p.avgMs).toBe(Math.round((100 + 300 + 1500) / 3));
    expect(p.p50).toBe(300);
    expect(p.p99).toBe(1500);
    expect(p.slowCount).toBe(1);
  });

  it('buckets the series by the given window (ASC)', () => {
    const p = profileRequests(rows, 60 * 60 * 1000);
    expect(p.perBucket).toHaveLength(2);
    expect(p.perBucket[0]).toMatchObject({ count: 2, avgMs: 200, slowCount: 0 });
    expect(p.perBucket[1]).toMatchObject({ count: 1, avgMs: 1500, slowCount: 1 });
    expect(p.perBucket[0].bucket < p.perBucket[1].bucket).toBe(true);
  });
});

describe('endpoint ranking', () => {
  it('normalizes ids so routes group, ranks by avg desc, caps latest requests', () => {
    const rows: PerfRow[] = [
      row({ path: '/api/v1/orders/2f9a1c3e-1111-2222-3333-444455556666', durationMs: 900, createdAt: at(3) }),
      row({ path: '/api/v1/orders/aaaa1c3e-9999-8888-7777-666655554444', durationMs: 700, createdAt: at(2) }),
      row({ path: '/api/v1/products', durationMs: 100, createdAt: at(1) }),
      row({ path: '/api/v1/products/42', durationMs: 200, createdAt: at(0) }),
    ];
    const ranked = rankEndpoints(rows, 20, 1);
    expect(ranked[0]).toMatchObject({ endpoint: 'GET /api/v1/orders/:id', count: 2, avgMs: 800, maxMs: 900, p95: 900 });
    expect(ranked[0].latest).toHaveLength(1); // capped
    expect(ranked.map((r) => r.endpoint)).toContain('GET /api/v1/products/:id');
    expect(normalizeEndpoint('POST', '/api/v1/checkout/order')).toBe('POST /api/v1/checkout/order');
  });

  it('returns at most top N', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ path: `/api/v1/e${i}`, durationMs: i }));
    expect(rankEndpoints(rows, 20)).toHaveLength(20);
  });
});

describe('module ranking', () => {
  it('averages by visual group, zero-fills all 8 groups', () => {
    const rows: PerfRow[] = [
      row({ module: 'worker.payment-lifecycle', durationMs: 400 }), // WORKER (prefix wins)
      row({ module: 'http', durationMs: 100 }), // SYSTEM
    ];
    const modules = rankModules(rows);
    expect(modules).toHaveLength(8);
    expect(modules.find((m) => m.group === 'WORKER')).toMatchObject({ count: 1, avgMs: 400 });
    expect(modules.find((m) => m.group === 'SYSTEM')).toMatchObject({ count: 1, avgMs: 100 });
    expect(modules.find((m) => m.group === 'PAYMENT')).toMatchObject({ count: 0, avgMs: 0 });
    expect(modules[0].group).toBe('WORKER'); // sorted by avg desc
  });
});

describe('worker aggregation', () => {
  it('splits success/failure per worker with percentiles + slow count', () => {
    const rows: PerfRow[] = [
      row({ module: 'worker.retention', action: 'tick', durationMs: 100 }),
      row({ module: 'worker.retention', action: 'tick.failed', durationMs: 6000 }), // slow (>= 5000)
      row({ module: 'worker.payment-lifecycle', action: 'tick', durationMs: 20 }),
    ];
    const w = profileWorkers(rows);
    expect(w).toMatchObject({ success: 2, failure: 1, slowCount: 1 });
    const retention = w.workers.find((x) => x.key === 'retention');
    expect(retention).toMatchObject({ count: 2, success: 1, failure: 1, maxMs: 6000 });
    expect(w.workers[0].key).toBe('retention'); // slowest first
  });
});

describe('db-perf registry (no raw SQL)', () => {
  it('maps SQL to a safe VERB Table name and never stores the SQL', () => {
    expect(queryNameFromSql('SELECT `db`.`Order`.`id` FROM `db`.`Order` WHERE `id` = ?')).toBe('SELECT Order');
    expect(queryNameFromSql('INSERT INTO `db`.`Payment` (`id`) VALUES (?)')).toBe('INSERT Payment');
    expect(queryNameFromSql('UPDATE `SystemLog` SET `level` = ?')).toBe('UPDATE SystemLog');
    expect(queryNameFromSql('BEGIN')).toBe('BEGIN');
  });

  it('aggregates count/avg/max/slow per name and ranks by avg', () => {
    const reg = new DbPerfRegistry();
    reg.record('SELECT Order', 100);
    reg.record('SELECT Order', 300); // avg 200, max 300, slow 1 (>= 200)
    reg.record('SELECT Product', 10);
    const snap = reg.snapshot(20);
    expect(snap.totalQueries).toBe(3);
    expect(snap.slowCount).toBe(1);
    expect(snap.queries[0]).toEqual({ name: 'SELECT Order', count: 2, avgMs: 200, maxMs: 300, slowCount: 1 });
    // The snapshot never contains SQL text or parameters.
    expect(JSON.stringify(snap)).not.toMatch(/WHERE|VALUES|\?/);
  });
});

describe('PerformanceProfilerService caching', () => {
  function svc(cacheOver: Record<string, unknown> = {}) {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const cache = {
      get: jest.fn().mockImplementation(async (k: string) => (k === 'performance:ping' ? 'ok' : undefined)),
      set: jest.fn(),
      ...cacheOver,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { service: new PerformanceProfilerService(prisma as any, cache as any), prisma, cache };
  }

  it('caches per range for 30s and skips compute on a hit', async () => {
    const { service, cache } = svc();
    await service.profile('7d');
    expect(cache.set).toHaveBeenCalledWith('admin:performance:7d', expect.any(Object), 30_000);
    const { service: s2, prisma: p2, cache: c2 } = svc({ get: jest.fn().mockResolvedValue({ cached: true }) });
    expect(await s2.profile('24h')).toEqual({ cached: true });
    expect(p2.$queryRaw).not.toHaveBeenCalled();
    expect(c2.set).not.toHaveBeenCalled();
  });

  it('compute returns the full payload shape with an empty window', async () => {
    const { service } = svc();
    const d = await service.compute('24h');
    expect(d.summary).toMatchObject({ avgResponseMs: 0, p95: 0, p99: 0, slowRequests: 0, slowWorkers: 0 });
    expect(d.modules).toHaveLength(8);
    expect(d.cache).toMatchObject({ connected: true });
    expect(d.range).toBe('24h');
  });
});

describe('Performance Profiler permission (SystemLog.read)', () => {
  function guard(user: { permissions?: string[] }) {
    const reflector = { getAllAndOverride: () => ['SystemLog.read'] };
    const g = new PermissionGuard(reflector as never);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ user }) }), getHandler: () => null, getClass: () => null } as never;
    return () => g.canActivate(ctx);
  }
  it('denies without SystemLog.read; allows with it', () => {
    expect(guard({ permissions: ['Dashboard.read'] })).toThrow(ForbiddenException);
    expect(guard({ permissions: ['SystemLog.read'] })()).toBe(true);
  });
});
