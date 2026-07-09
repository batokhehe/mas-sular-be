/**
 * PURE helpers for the Request Explorer — turn the SystemLog rows that share one
 * requestId into a summary + chronological timeline. No I/O so everything here is
 * unit-testable standalone. Reuses existing SystemLog data only (read-only).
 */

export type RequestGroup =
  | 'AUTH'
  | 'ORDER'
  | 'PAYMENT'
  | 'INVENTORY'
  | 'SHIPMENT'
  | 'NOTIFICATION'
  | 'WORKER'
  | 'SYSTEM';

/** Minimal SystemLog row shape the helpers need (subset of the Prisma model). */
export interface RequestLogRow {
  id: string;
  createdAt: Date;
  level: string;
  module: string;
  action: string;
  message: string;
  requestId: string | null;
  userId: string | null;
  adminId: string | null;
  orderId: string | null;
  paymentId: string | null;
  shipmentId: string | null;
  ip: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  durationMs: number | null;
  metadata: unknown;
}

export interface RequestTimelineEvent {
  id: string;
  time: string; // ISO
  module: string;
  action: string;
  group: RequestGroup;
  level: string;
  message: string;
  durationMs: number | null;
  statusCode: number | null;
  metadata: unknown;
}

/** Map a SystemLog module to its visual group. `worker.*` wins over keyword hits. */
export function moduleGroup(module: string): RequestGroup {
  const m = module.toLowerCase();
  if (m.startsWith('worker.')) return 'WORKER';
  if (m.includes('auth')) return 'AUTH';
  if (m.includes('checkout') || m.includes('order') || m.includes('voucher')) return 'ORDER';
  if (m.includes('payment')) return 'PAYMENT';
  if (m.includes('inventory') || m.includes('reservation') || m.includes('stock')) return 'INVENTORY';
  if (m.includes('shipment') || m.includes('shipping')) return 'SHIPMENT';
  if (m.includes('notification') || m.includes('outbox')) return 'NOTIFICATION';
  return 'SYSTEM'; // http, exception, ...
}

/** Chronological (ASC) timeline regardless of input order. */
export function buildRequestTimeline(rows: RequestLogRow[]): RequestTimelineEvent[] {
  return [...rows]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => ({
      id: r.id,
      time: r.createdAt.toISOString(),
      module: r.module,
      action: r.action,
      group: moduleGroup(r.module),
      level: r.level,
      message: r.message,
      durationMs: r.durationMs,
      statusCode: r.statusCode,
      metadata: r.metadata ?? null,
    }));
}

/** Tiny UA sniff — display-only (no client hints, no fingerprinting). */
export function parseUserAgent(ua: string | null | undefined): { browser: string; device: string } {
  if (!ua) return { browser: 'Unknown', device: 'Unknown' };
  const browser = /postman/i.test(ua)
    ? 'Postman'
    : /curl/i.test(ua)
      ? 'curl'
      : /edg\//i.test(ua)
        ? 'Edge'
        : /opr\//i.test(ua)
          ? 'Opera'
          : /chrome|crios/i.test(ua)
            ? 'Chrome'
            : /firefox|fxios/i.test(ua)
              ? 'Firefox'
              : /safari/i.test(ua)
                ? 'Safari'
                : 'Other';
  const device = /mobile|android|iphone|ipad/i.test(ua) ? 'Mobile' : 'Desktop';
  return { browser, device };
}

export interface RequestSummary {
  requestId: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  responseCode: number | null;
  userId: string | null;
  adminId: string | null;
  ip: string | null;
  browser: string;
  device: string;
  totalLogs: number;
  errorCount: number;
  warningCount: number;
}

/**
 * Summarize one request from its rows. The `http/request.finished` row (written by
 * the request-logging middleware) carries method/path/status/duration + userAgent;
 * everything degrades gracefully when it is absent (e.g. exception-only requests).
 */
export function buildRequestSummary(rows: RequestLogRow[]): RequestSummary {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  // Last http row = the request.finished record.
  const http = [...sorted].reverse().find((r) => r.module === 'http') ?? null;

  const finishedAt = http?.createdAt ?? last.createdAt;
  const duration = http?.durationMs ?? null;
  // Start = finish − duration when known (the middleware logs at response finish);
  // never later than the earliest correlated row.
  const startCandidate = duration != null ? new Date(finishedAt.getTime() - duration) : first.createdAt;
  const startedAt = startCandidate.getTime() < first.createdAt.getTime() ? startCandidate : first.createdAt;

  const pick = <K extends keyof RequestLogRow>(key: K): RequestLogRow[K] | null => {
    for (const r of sorted) if (r[key] != null) return r[key];
    return null;
  };

  const ua = ((http?.metadata ?? null) as { userAgent?: string } | null)?.userAgent;
  const { browser, device } = parseUserAgent(ua);
  const statusCode = http?.statusCode ?? (pick('statusCode') as number | null);

  return {
    requestId: first.requestId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: duration ?? Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    method: http?.method ?? (pick('method') as string | null),
    path: http?.path ?? (pick('path') as string | null),
    statusCode,
    responseCode: statusCode,
    userId: pick('userId') as string | null,
    adminId: pick('adminId') as string | null,
    ip: pick('ip') as string | null,
    browser,
    device,
    totalLogs: rows.length,
    errorCount: rows.filter((r) => r.level === 'ERROR').length,
    warningCount: rows.filter((r) => r.level === 'WARN').length,
  };
}

export interface RelatedIds {
  orderId: string | null;
  paymentId: string | null;
  shipmentId: string | null;
  userId: string | null;
}

/** First non-null related entity ids across the request's rows (clickable links). */
export function relatedIds(rows: RequestLogRow[]): RelatedIds {
  const pick = (key: 'orderId' | 'paymentId' | 'shipmentId' | 'userId'): string | null => {
    for (const r of rows) if (r[key]) return r[key];
    return null;
  };
  return { orderId: pick('orderId'), paymentId: pick('paymentId'), shipmentId: pick('shipmentId'), userId: pick('userId') };
}
