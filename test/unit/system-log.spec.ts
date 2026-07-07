import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { LogService } from '../../src/infrastructure/logging/log.service';
import { runWithRequestContext } from '../../src/infrastructure/logging/request-context';
import { SystemLogQueryService } from '../../src/infrastructure/logging/system-log-query.service';
import { LogRetentionWorker } from '../../src/infrastructure/logging/log-retention.worker';
import { RequestLoggingMiddleware } from '../../src/infrastructure/logging/request-logging.middleware';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { PermissionGuard } from '../../src/common/guards/permission.guard';

const tick = () => new Promise((r) => setImmediate(r));
const config = (over: Record<string, unknown> = {}) => ({ enabled: true, retentionDays: 90, retentionEnabled: true, retentionIntervalMs: 1, retentionInitialDelayMs: 1, ...over }) as never;

describe('LogService.write', () => {
  it('persists a structured log (fire-and-forget) with defaults', async () => {
    const create = jest.fn().mockResolvedValue({});
    const svc = new LogService({ systemLog: { create } } as never, config());
    svc.write({ module: 'orders', action: 'checkout', message: 'ok', orderId: 'o1' });
    await tick();
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ level: 'INFO', module: 'orders', action: 'checkout', message: 'ok', orderId: 'o1' }) });
  });

  it('auto-fills requestId from the AsyncLocalStorage context (correlation)', async () => {
    const create = jest.fn().mockResolvedValue({});
    const svc = new LogService({ systemLog: { create } } as never, config());
    runWithRequestContext({ requestId: 'req-42', ip: '1.2.3.4' }, () => svc.write({ module: 'm', action: 'a', message: 'x' }));
    await tick();
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ requestId: 'req-42', ip: '1.2.3.4' }) });
  });

  it('never throws and does not persist when disabled', async () => {
    const create = jest.fn().mockRejectedValue(new Error('db down'));
    const svc = new LogService({ systemLog: { create } } as never, config({ enabled: false }));
    expect(() => svc.write({ module: 'm', action: 'a', message: 'x' })).not.toThrow();
    await tick();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('SystemLogQueryService — filtering / pagination / search', () => {
  function svc(rows: unknown[] = [{ id: 'l1' }], total = 1) {
    const systemLog = { findMany: jest.fn().mockResolvedValue(rows), count: jest.fn().mockResolvedValue(total), findUnique: jest.fn() };
    return { service: new SystemLogQueryService({ systemLog } as never), systemLog };
  }

  it('paginates newest-first by default and returns the envelope', async () => {
    const { service, systemLog } = svc([{ id: 'l1' }], 57);
    const res = await service.list({});
    expect(systemLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20, orderBy: { createdAt: 'desc' } }));
    expect(res).toEqual(expect.objectContaining({ page: 1, limit: 20, total: 57, totalPages: 3 }));
  });

  it('builds a where clause from every filter facet', () => {
    const { service } = svc();
    const from = new Date('2026-07-01'); const to = new Date('2026-07-02');
    const where = service.buildWhere({ level: 'ERROR' as never, module: 'http', statusCode: 500, orderId: 'o1', dateFrom: from, dateTo: to });
    expect(where).toMatchObject({ level: 'ERROR', module: 'http', statusCode: 500, orderId: 'o1', createdAt: { gte: from, lte: to } });
  });

  it('search matches message + id fields', () => {
    const { service } = svc();
    const where = service.buildWhere({ search: 'BMS-1' });
    expect(where.OR).toEqual(expect.arrayContaining([{ message: { contains: 'BMS-1' } }, { requestId: 'BMS-1' }, { orderId: 'BMS-1' }, { paymentId: 'BMS-1' }]));
  });

  it('honours ascending sort', async () => {
    const { service, systemLog } = svc();
    await service.list({ sort: 'asc' });
    expect(systemLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'asc' } }));
  });

  it('detail 404s when the log is missing', async () => {
    const { service, systemLog } = svc();
    systemLog.findUnique.mockResolvedValue(null);
    await expect(service.get('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('LogRetentionWorker.sweep', () => {
  it('deletes logs older than the retention cutoff', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 5 });
    const logs = { write: jest.fn() };
    const worker = new LogRetentionWorker({ systemLog: { deleteMany } } as never, logs as never, config({ retentionDays: 30 }));
    (worker as unknown as { nowMs: () => number }).nowMs = () => new Date('2026-07-31T00:00:00Z').getTime();
    const n = await worker.sweep();
    expect(n).toBe(5);
    const cutoff = deleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    expect(cutoff.toISOString()).toBe('2026-07-01T00:00:00.000Z'); // 30 days before now
    expect(logs.write).toHaveBeenCalledWith(expect.objectContaining({ module: 'worker.log-retention', action: 'retention.sweep' }));
  });
});

describe('RequestLoggingMiddleware', () => {
  function run(reqOver: Record<string, unknown> = {}, status = 200) {
    const logs = { write: jest.fn() };
    const mw = new RequestLoggingMiddleware(logs as never, config());
    let finish: (() => void) | undefined;
    const res = { setHeader: jest.fn(), statusCode: status, on: (evt: string, cb: () => void) => { if (evt === 'finish') finish = cb; } };
    const req = { method: 'GET', originalUrl: '/api/v1/admin/orders', headers: {}, params: {}, query: {}, ip: '9.9.9.9', socket: {}, ...reqOver };
    const next = jest.fn();
    mw.use(req as never, res as never, next);
    return { logs, res, req, next, finish };
  }

  it('logs request.finished with status/level/duration + sets X-Request-Id', () => {
    const { logs, res, next, finish } = run({}, 200);
    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', expect.any(String));
    finish!();
    expect(logs.write).toHaveBeenCalledWith(expect.objectContaining({
      module: 'http', action: 'request.finished', level: 'INFO', method: 'GET', statusCode: 200, durationMs: expect.any(Number),
    }));
  });

  it('classifies 5xx as ERROR and 4xx as WARN', () => {
    const a = run({}, 500); a.finish!();
    expect(a.logs.write).toHaveBeenCalledWith(expect.objectContaining({ level: 'ERROR' }));
    const b = run({}, 403); b.finish!();
    expect(b.logs.write).toHaveBeenCalledWith(expect.objectContaining({ level: 'WARN' }));
  });

  it('skips noise endpoints (health) — no log, no finish handler', () => {
    const { logs, next, finish } = run({ originalUrl: '/api/v1/health' });
    expect(next).toHaveBeenCalled();
    expect(finish).toBeUndefined();
    expect(logs.write).not.toHaveBeenCalled();
  });
});

describe('AllExceptionsFilter → SystemLog', () => {
  function host(url = '/api/v1/x', method = 'GET') {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    return {
      json, status,
      switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => ({ url, method }) }),
    } as never;
  }

  it('persists a WARN log for an HttpException (permission denied)', () => {
    const logs = { write: jest.fn() };
    const filter = new AllExceptionsFilter({ error: jest.fn() } as never, logs as never);
    filter.catch(new ForbiddenException('Insufficient permissions'), host());
    expect(logs.write).toHaveBeenCalledWith(expect.objectContaining({ level: 'WARN', module: 'exception', action: 'ForbiddenException', statusCode: 403 }));
  });

  it('persists an ERROR log with a stack for an unhandled error (500)', () => {
    const logs = { write: jest.fn() };
    const filter = new AllExceptionsFilter({ error: jest.fn() } as never, logs as never);
    filter.catch(new Error('boom'), host());
    const entry = logs.write.mock.calls[0][0];
    expect(entry).toMatchObject({ level: 'ERROR', module: 'exception', statusCode: 500 });
    expect(entry.metadata.stack).toContain('boom');
  });
});

describe('SystemLog.read permission', () => {
  function guard(user: { role?: string; permissions?: string[] } | undefined) {
    const reflector = { getAllAndOverride: () => ['SystemLog.read'] };
    const g = new PermissionGuard(reflector as never);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ user }) }), getHandler: () => null, getClass: () => null } as never;
    return () => g.canActivate(ctx);
  }

  it('denies an admin without SystemLog.read', () => {
    expect(guard({ permissions: ['Dashboard.read'] })).toThrow(ForbiddenException);
  });
  it('allows an admin holding SystemLog.read', () => {
    expect(guard({ permissions: ['SystemLog.read'] })()).toBe(true);
  });
  it('allows a super admin', () => {
    expect(guard({ role: 'SUPER_ADMIN', permissions: [] })()).toBe(true);
  });
});
