import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  buildRequestSummary,
  buildRequestTimeline,
  moduleGroup,
  parseUserAgent,
  relatedIds,
  RequestLogRow,
} from '../../src/infrastructure/logging/request-explorer.util';
import { RequestExplorerService } from '../../src/infrastructure/logging/request-explorer.service';
import { PermissionGuard } from '../../src/common/guards/permission.guard';

const T0 = new Date('2026-07-07T14:31:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

function row(over: Partial<RequestLogRow> = {}): RequestLogRow {
  return {
    id: over.id ?? 'l1',
    createdAt: over.createdAt ?? T0,
    level: 'INFO',
    module: 'http',
    action: 'request.finished',
    message: 'GET /x 200',
    requestId: 'req-1',
    userId: null, adminId: null, orderId: null, paymentId: null, shipmentId: null,
    ip: '1.2.3.4', method: 'GET', path: '/api/v1/x', statusCode: 200, durationMs: 120,
    metadata: null,
    ...over,
  };
}

describe('request-explorer.util — grouping', () => {
  it('maps modules to visual groups (worker.* wins over keyword hits)', () => {
    expect(moduleGroup('worker.payment-lifecycle')).toBe('WORKER');
    expect(moduleGroup('auth')).toBe('AUTH');
    expect(moduleGroup('orders.checkout')).toBe('ORDER');
    expect(moduleGroup('payments')).toBe('PAYMENT');
    expect(moduleGroup('inventory-reservation')).toBe('INVENTORY');
    expect(moduleGroup('shipment')).toBe('SHIPMENT');
    expect(moduleGroup('notification-sender')).toBe('NOTIFICATION');
    expect(moduleGroup('http')).toBe('SYSTEM');
    expect(moduleGroup('exception')).toBe('SYSTEM');
  });
});

describe('request-explorer.util — timeline ordering', () => {
  it('sorts rows chronologically ASC regardless of input order', () => {
    const rows = [
      row({ id: 'c', module: 'http', createdAt: at(9) }),
      row({ id: 'a', module: 'auth', action: 'jwt.validated', createdAt: at(1) }),
      row({ id: 'b', module: 'payments', action: 'payment.created', createdAt: at(5) }),
    ];
    const timeline = buildRequestTimeline(rows);
    expect(timeline.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(timeline[0]).toMatchObject({ group: 'AUTH', action: 'jwt.validated', level: 'INFO' });
    expect(timeline[1].group).toBe('PAYMENT');
    expect(timeline[2].group).toBe('SYSTEM');
  });
});

describe('request-explorer.util — summary', () => {
  it('derives started/finished/duration/method/path/status + browser/device from the http row', () => {
    const rows = [
      row({ id: 'e1', module: 'exception', action: 'BadRequestException', level: 'WARN', createdAt: at(1), method: null, path: null, statusCode: 400, durationMs: null }),
      row({
        id: 'h1', createdAt: at(2), durationMs: 2000, statusCode: 400, userId: 'u1',
        metadata: { userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit CriOS/119 Mobile Safari' },
      }),
    ];
    const s = buildRequestSummary(rows);
    expect(s.finishedAt).toBe(at(2).toISOString());
    expect(s.startedAt).toBe(at(0).toISOString()); // finish − 2000ms, earlier than first row
    expect(s.durationMs).toBe(2000);
    expect(s).toMatchObject({ method: 'GET', path: '/api/v1/x', statusCode: 400, responseCode: 400, userId: 'u1', ip: '1.2.3.4' });
    expect(s.browser).toBe('Chrome'); // CriOS
    expect(s.device).toBe('Mobile');
    expect(s).toMatchObject({ totalLogs: 2, errorCount: 0, warningCount: 1 });
  });

  it('degrades gracefully without an http row (exception-only request)', () => {
    const rows = [row({ module: 'exception', method: null, path: null, durationMs: null, statusCode: 500, level: 'ERROR', metadata: {} })];
    const s = buildRequestSummary(rows);
    expect(s.statusCode).toBe(500);
    expect(s.browser).toBe('Unknown');
    expect(s.errorCount).toBe(1);
  });

  it('parseUserAgent detects common browsers and tools', () => {
    expect(parseUserAgent('PostmanRuntime/7.36').browser).toBe('Postman');
    expect(parseUserAgent('curl/8.4.0').browser).toBe('curl');
    expect(parseUserAgent('Mozilla/5.0 Firefox/121.0')).toMatchObject({ browser: 'Firefox', device: 'Desktop' });
    expect(parseUserAgent(null)).toEqual({ browser: 'Unknown', device: 'Unknown' });
  });

  it('relatedIds collects the first non-null entity ids', () => {
    const rows = [row({ orderId: 'o1' }), row({ id: 'l2', paymentId: 'p1', userId: 'u1' })];
    expect(relatedIds(rows)).toEqual({ orderId: 'o1', paymentId: 'p1', shipmentId: null, userId: 'u1' });
  });
});

describe('RequestExplorerService', () => {
  function build(over: Record<string, unknown> = {}) {
    const prisma = {
      systemLog: {
        findMany: jest.fn().mockResolvedValue([row({ requestId: 'req-1', userId: 'u1' })]),
        count: jest.fn().mockResolvedValue(41),
        groupBy: jest.fn().mockResolvedValue([
          { requestId: 'req-1', level: 'INFO', _count: { _all: 3 } },
          { requestId: 'req-1', level: 'ERROR', _count: { _all: 2 } },
          { requestId: 'req-1', level: 'WARN', _count: { _all: 1 } },
        ]),
      },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', name: 'Jane', email: 'jane@x.com' }]) },
      admin: { findMany: jest.fn().mockResolvedValue([]) },
      ...over,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { service: new RequestExplorerService(prisma as any), prisma };
  }

  it('list: paginates newest-first over http rows and returns the envelope + per-request counts', async () => {
    const { service, prisma } = build();
    const res = await service.list({ page: 2, limit: 20 });
    expect(prisma.systemLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20, orderBy: { createdAt: 'desc' }, where: expect.objectContaining({ module: 'http' }) }),
    );
    expect(res).toEqual(expect.objectContaining({ page: 2, limit: 20, total: 41, totalPages: 3 }));
    expect(res.items[0]).toMatchObject({
      requestId: 'req-1', method: 'GET', statusCode: 200, durationMs: 120,
      totalLogs: 6, errorCount: 2, warningCount: 1,
      user: { id: 'u1', name: 'Jane', email: 'jane@x.com' },
    });
    // Counts came from ONE grouped query (no N+1).
    expect(prisma.systemLog.groupBy).toHaveBeenCalledTimes(1);
  });

  it('filters: method/statusCode/path/date narrow the where clause', async () => {
    const { service } = build();
    const from = new Date('2026-07-01'); const to = new Date('2026-07-07');
    const where = await service.buildWhere({ method: 'post', statusCode: 500, path: '/checkout', dateFrom: from, dateTo: to });
    expect(where).toMatchObject({
      module: 'http', method: 'POST', statusCode: 500,
      path: { contains: '/checkout' }, createdAt: { gte: from, lte: to },
    });
  });

  it('search: matches requestId/orderId/paymentId/shipmentId and resolves customers by email/name', async () => {
    const { service, prisma } = build();
    const where = await service.buildWhere({ search: 'jane' });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ email: { contains: 'jane' } }, { name: { contains: 'jane' } }] }, take: 20 }),
    );
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { requestId: 'jane' }, { orderId: 'jane' }, { paymentId: 'jane' }, { shipmentId: 'jane' },
        { userId: { in: ['u1'] } },
      ]),
    );
  });

  it('detail: returns summary + ASC timeline + related, with the actor resolved', async () => {
    const { service } = build({
      systemLog: {
        findMany: jest.fn().mockResolvedValue([
          row({ id: 'a', module: 'auth', action: 'jwt.validated', createdAt: at(1), userId: 'u1', durationMs: null }),
          row({ id: 'h', createdAt: at(3), durationMs: 3000, orderId: 'o1' }),
        ]),
        count: jest.fn(), groupBy: jest.fn(),
      },
    });
    const d = await service.detail('req-1');
    expect(d.timeline.map((e) => e.id)).toEqual(['a', 'h']);
    expect(d.summary).toMatchObject({ requestId: 'req-1', durationMs: 3000, user: { id: 'u1', name: 'Jane' } });
    expect(d.related).toMatchObject({ orderId: 'o1', userId: 'u1' });
  });

  it('detail: 404 for an unknown requestId', async () => {
    const { service } = build({ systemLog: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn(), groupBy: jest.fn() } });
    await expect(service.detail('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Request Explorer permission (SystemLog.read)', () => {
  function guard(user: { role?: string; permissions?: string[] }) {
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
