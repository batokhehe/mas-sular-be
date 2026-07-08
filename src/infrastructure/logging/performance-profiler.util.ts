import { moduleGroup, RequestGroup } from './request-explorer.util';

/**
 * PURE profiling helpers for the Performance Profiler. One bounded set of
 * SystemLog rows (durationMs != null) is aggregated entirely in memory — no I/O,
 * so percentiles / ranking / bucketing are unit-testable standalone.
 */

export const SLOW_REQUEST_MS = 1000;
export const SLOW_WORKER_MS = 5000;

/** Minimal SystemLog row shape the profiler needs. */
export interface PerfRow {
  module: string;
  action: string;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  durationMs: number;
  createdAt: Date;
}

/** Nearest-rank percentile over an ASC-sorted array (0 when empty). */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

const avg = (nums: number[]): number => (nums.length === 0 ? 0 : Math.round(nums.reduce((s, n) => s + n, 0) / nums.length));

/** Collapse concrete ids so routes group together: UUIDs and numeric segments → :id. */
export function normalizeEndpoint(method: string | null, path: string | null): string {
  const cleaned = (path ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
  return `${method ?? 'GET'} ${cleaned}`;
}

export interface RequestsProfile {
  count: number;
  avgMs: number;
  p50: number;
  p95: number;
  p99: number;
  slowCount: number;
  perBucket: Array<{ bucket: string; count: number; avgMs: number; slowCount: number }>;
}

/** Requests profile (http rows): percentiles + time-bucketed series (ASC by bucket). */
export function profileRequests(rows: PerfRow[], bucketMs: number): RequestsProfile {
  const http = rows.filter((r) => r.module === 'http');
  const durations = http.map((r) => r.durationMs).sort((a, b) => a - b);
  const buckets = new Map<number, { durations: number[]; slow: number }>();
  for (const r of http) {
    const key = Math.floor(r.createdAt.getTime() / bucketMs) * bucketMs;
    const b = buckets.get(key) ?? { durations: [], slow: 0 };
    b.durations.push(r.durationMs);
    if (r.durationMs >= SLOW_REQUEST_MS) b.slow += 1;
    buckets.set(key, b);
  }
  const perBucket = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, b]) => ({ bucket: new Date(key).toISOString(), count: b.durations.length, avgMs: avg(b.durations), slowCount: b.slow }));

  return {
    count: http.length,
    avgMs: avg(durations),
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    slowCount: http.filter((r) => r.durationMs >= SLOW_REQUEST_MS).length,
    perBucket,
  };
}

export interface EndpointStat {
  endpoint: string;
  method: string;
  path: string;
  count: number;
  avgMs: number;
  maxMs: number;
  p95: number;
  p99: number;
  /** Most recent requests hitting this endpoint (rows arrive DESC by createdAt). */
  latest: Array<{ time: string; durationMs: number; statusCode: number | null }>;
}

/** Top-N slowest endpoints by average duration (ties broken by count desc). */
export function rankEndpoints(rows: PerfRow[], top = 20, latestPerEndpoint = 5): EndpointStat[] {
  const byEndpoint = new Map<string, { method: string; path: string; durations: number[]; latest: EndpointStat['latest'] }>();
  for (const r of rows) {
    if (r.module !== 'http') continue;
    const endpoint = normalizeEndpoint(r.method, r.path);
    const e = byEndpoint.get(endpoint) ?? { method: r.method ?? 'GET', path: endpoint.slice((r.method ?? 'GET').length + 1), durations: [], latest: [] };
    e.durations.push(r.durationMs);
    if (e.latest.length < latestPerEndpoint) {
      e.latest.push({ time: r.createdAt.toISOString(), durationMs: r.durationMs, statusCode: r.statusCode });
    }
    byEndpoint.set(endpoint, e);
  }
  return [...byEndpoint.entries()]
    .map(([endpoint, e]) => {
      const sorted = [...e.durations].sort((a, b) => a - b);
      return {
        endpoint,
        method: e.method,
        path: e.path,
        count: sorted.length,
        avgMs: avg(sorted),
        maxMs: sorted[sorted.length - 1] ?? 0,
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        latest: e.latest,
      };
    })
    .sort((a, b) => b.avgMs - a.avgMs || b.count - a.count)
    .slice(0, top);
}

export interface ModuleStat {
  group: RequestGroup;
  count: number;
  avgMs: number;
  maxMs: number;
}

const ALL_GROUPS: RequestGroup[] = ['AUTH', 'ORDER', 'PAYMENT', 'INVENTORY', 'SHIPMENT', 'NOTIFICATION', 'WORKER', 'SYSTEM'];

/** Average duration per visual module group (zero-filled so every group renders). */
export function rankModules(rows: PerfRow[]): ModuleStat[] {
  const byGroup = new Map<RequestGroup, number[]>();
  for (const r of rows) {
    const g = moduleGroup(r.module);
    const list = byGroup.get(g) ?? [];
    list.push(r.durationMs);
    byGroup.set(g, list);
  }
  return ALL_GROUPS.map((group) => {
    const durations = byGroup.get(group) ?? [];
    return { group, count: durations.length, avgMs: avg(durations), maxMs: durations.length ? Math.max(...durations) : 0 };
  }).sort((a, b) => b.avgMs - a.avgMs);
}

export interface WorkersProfile {
  avgMs: number;
  p95: number;
  p99: number;
  success: number;
  failure: number;
  slowCount: number;
  workers: Array<{ key: string; name: string; count: number; avgMs: number; p95: number; p99: number; maxMs: number; success: number; failure: number }>;
}

/** Worker tick profile from `worker.*` rows (per worker + overall). */
export function profileWorkers(rows: PerfRow[]): WorkersProfile {
  const workerRows = rows.filter((r) => r.module.startsWith('worker.'));
  const byWorker = new Map<string, { durations: number[]; success: number; failure: number }>();
  for (const r of workerRows) {
    const key = r.module.slice('worker.'.length);
    const w = byWorker.get(key) ?? { durations: [], success: 0, failure: 0 };
    w.durations.push(r.durationMs);
    if (r.action === 'tick.failed') w.failure += 1;
    else w.success += 1;
    byWorker.set(key, w);
  }
  const all = workerRows.map((r) => r.durationMs).sort((a, b) => a - b);
  return {
    avgMs: avg(all),
    p95: percentile(all, 95),
    p99: percentile(all, 99),
    success: workerRows.filter((r) => r.action !== 'tick.failed').length,
    failure: workerRows.filter((r) => r.action === 'tick.failed').length,
    slowCount: workerRows.filter((r) => r.durationMs >= SLOW_WORKER_MS).length,
    workers: [...byWorker.entries()]
      .map(([key, w]) => {
        const sorted = [...w.durations].sort((a, b) => a - b);
        return {
          key,
          name: key.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          count: sorted.length,
          avgMs: avg(sorted),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
          maxMs: sorted[sorted.length - 1] ?? 0,
          success: w.success,
          failure: w.failure,
        };
      })
      .sort((a, b) => b.avgMs - a.avgMs),
  };
}
