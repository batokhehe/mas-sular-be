import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { evaluateRules, loadIncidentThresholds, IncidentSignals } from '../../src/infrastructure/logging/incident.rules';
import { IncidentCenterService } from '../../src/infrastructure/logging/incident-center.service';
import { PermissionGuard } from '../../src/common/guards/permission.guard';

const T = loadIncidentThresholds({}); // defaults: 5% / 100 / 3 / 5 / 3000ms / 200ms

function signals(over: Partial<IncidentSignals> = {}): IncidentSignals {
  return {
    requests: { count: 100, errors: 0 },
    workers: [],
    outbox: { pending: 0, failed: 0, oldestPendingAgeMs: null },
    notifications: { pending: 0, failed: 0 },
    redisConnected: true,
    rabbitConfigured: true,
    checkoutP95Ms: 0,
    dbWorst: null,
    ...over,
  };
}

describe('incident rules — creation + severity', () => {
  it('healthy signals produce no incidents', () => {
    expect(evaluateRules(signals(), T)).toEqual([]);
  });

  it('error rate: HIGH above threshold, CRITICAL above 2x', () => {
    const high = evaluateRules(signals({ requests: { count: 100, errors: 6 } }), T);
    expect(high[0]).toMatchObject({ type: 'error-rate', severity: 'HIGH', source: 'system-log' });
    const critical = evaluateRules(signals({ requests: { count: 100, errors: 12 } }), T);
    expect(critical[0].severity).toBe('CRITICAL');
    // Too little traffic → no incident (10-request floor).
    expect(evaluateRules(signals({ requests: { count: 5, errors: 5 } }), T)).toEqual([]);
  });

  it('worker failing consecutively: fires only when nothing succeeded after the failures', () => {
    const failing = evaluateRules(signals({ workers: [{ key: 'payment-lifecycle', failures: 3, lastFailure: '2026-07-07T10:05:00Z', lastSuccess: '2026-07-07T10:00:00Z' }] }), T);
    expect(failing[0]).toMatchObject({ type: 'worker-failing:payment-lifecycle', severity: 'HIGH', worker: 'payment-lifecycle' });
    // Recovered (success after failure) → no incident.
    const recovered = evaluateRules(signals({ workers: [{ key: 'retention', failures: 5, lastFailure: '2026-07-07T10:00:00Z', lastSuccess: '2026-07-07T10:05:00Z' }] }), T);
    expect(recovered).toEqual([]);
  });

  it('queue backlog: MEDIUM at threshold, HIGH at 10x; notification failures escalate', () => {
    const med = evaluateRules(signals({ outbox: { pending: 150, failed: 0, oldestPendingAgeMs: 1000 } }), T);
    expect(med.find((c) => c.type === 'queue-pending:outbox')?.severity).toBe('MEDIUM');
    const high = evaluateRules(signals({ notifications: { pending: 1500, failed: 0 } }), T);
    expect(high.find((c) => c.type === 'queue-pending:notifications')?.severity).toBe('HIGH');
    const notif = evaluateRules(signals({ notifications: { pending: 0, failed: 20 } }), T);
    expect(notif.find((c) => c.type === 'notification-failures')?.severity).toBe('HIGH');
  });

  it('redis down and stalled outbox are CRITICAL; checkout p95 + db latency fire', () => {
    const all = evaluateRules(
      signals({
        redisConnected: false,
        outbox: { pending: 5, failed: 0, oldestPendingAgeMs: 15 * 60 * 1000 },
        checkoutP95Ms: 3500,
        dbWorst: { name: 'SELECT Order', avgMs: 250, count: 50 },
      }),
      T,
    );
    const types = all.map((c) => c.type);
    expect(types).toEqual(expect.arrayContaining(['redis-down', 'outbox-stalled', 'checkout-p95', 'db-latency:SELECT Order']));
    expect(all.find((c) => c.type === 'redis-down')?.severity).toBe('CRITICAL');
    expect(all.find((c) => c.type === 'outbox-stalled')?.severity).toBe('CRITICAL');
    expect(all.find((c) => c.type === 'checkout-p95')?.severity).toBe('HIGH');
    // Few samples → no db incident.
    expect(evaluateRules(signals({ dbWorst: { name: 'SELECT X', avgMs: 900, count: 3 } }), T)).toEqual([]);
  });
});

describe('IncidentCenterService', () => {
  function build(over: Record<string, unknown> = {}) {
    const prisma = {
      incident: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({ id: 'inc-1', module: 'http', requestId: null, firstSeen: new Date() }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'inc-1', status: 'ACKNOWLEDGED' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'inc-1' }]),
        count: jest.fn().mockResolvedValue(3),
        create: jest.fn().mockResolvedValue({ id: 'inc-new' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      systemLog: { findMany: jest.fn().mockResolvedValue([{ id: 'l1' }]) },
      $queryRaw: jest.fn().mockResolvedValue([{}]),
      ...over,
    };
    const cache = {
      get: jest.fn().mockImplementation(async (k: string) => (k === 'incidents:ping' ? 'ok' : undefined)),
      set: jest.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { service: new IncidentCenterService(prisma as any, cache as any), prisma, cache };
  }

  it('incident creation: a firing rule with no active twin creates a new row', async () => {
    const { service, prisma } = build();
    // Force one candidate: redis down (cache get for the ping returns undefined).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).redisPing = jest.fn().mockResolvedValue(false);
    const n = await service.detectAndUpsert();
    expect(n).toBe(1);
    expect(prisma.incident.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'redis-down', severity: 'CRITICAL' }) }));
  });

  it('dedup: an active incident of the same type bumps count/lastSeen (and can escalate, never de-escalate)', async () => {
    const { service, prisma } = build();
    prisma.incident.findFirst.mockResolvedValue({ id: 'inc-1', severity: 'CRITICAL' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).redisPing = jest.fn().mockResolvedValue(false);
    await service.detectAndUpsert();
    expect(prisma.incident.create).not.toHaveBeenCalled();
    const data = prisma.incident.update.mock.calls[0][0].data;
    expect(data.count).toEqual({ increment: 1 });
    expect(data.severity).toBeUndefined(); // CRITICAL existing not downgraded
  });

  it('acknowledge: CAS OPEN → ACKNOWLEDGED with actor + timestamp; conflict when not OPEN', async () => {
    const { service, prisma } = build();
    await service.acknowledge('inc-1', 'admin-1');
    expect(prisma.incident.updateMany).toHaveBeenCalledWith({
      where: { id: 'inc-1', status: 'OPEN' },
      data: expect.objectContaining({ status: 'ACKNOWLEDGED', acknowledgedBy: 'admin-1', acknowledgedAt: expect.any(Date) }),
    });
    prisma.incident.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.acknowledge('inc-1', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    prisma.incident.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.incident.findUnique.mockResolvedValueOnce(null);
    await expect(service.acknowledge('missing', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolve: allowed from OPEN or ACKNOWLEDGED, records who/when', async () => {
    const { service, prisma } = build();
    await service.resolve('inc-1', 'admin-2');
    expect(prisma.incident.updateMany).toHaveBeenCalledWith({
      where: { id: 'inc-1', status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      data: expect.objectContaining({ status: 'RESOLVED', resolvedBy: 'admin-2', resolvedAt: expect.any(Date) }),
    });
  });

  it('sweep cache: 30s gate — a cached marker skips detection entirely', async () => {
    const { service, cache } = build();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detect = jest.spyOn(service as any, 'detectAndUpsert').mockResolvedValue(0);
    cache.get.mockImplementation(async (k: string) => (k === 'admin:incidents:last-sweep' ? Date.now() : undefined));
    expect(await service.sweepIfDue()).toBe(false);
    expect(detect).not.toHaveBeenCalled();
    cache.get.mockResolvedValue(undefined);
    expect(await service.sweepIfDue()).toBe(true);
    expect(cache.set).toHaveBeenCalledWith('admin:incidents:last-sweep', expect.any(Number), 30_000);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('list: sweeps first, paginates newest-first (lastSeen), returns summary cards', async () => {
    const { service, prisma } = build();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(service as any, 'sweepIfDue').mockResolvedValue(true);
    const res = await service.list({ page: 1, limit: 20, severity: 'HIGH' as never });
    expect(prisma.incident.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { lastSeen: 'desc' }, where: expect.objectContaining({ severity: 'HIGH' }) }));
    expect(res.summary).toEqual({ open: 3, critical: 3, high: 3, acknowledged: 3, resolvedToday: 3 });
    expect(res).toEqual(expect.objectContaining({ page: 1, limit: 20, total: 3 }));
  });

  it('detail: 404 for unknown; returns correlated SystemLog timeline otherwise', async () => {
    const { service, prisma } = build();
    const d = await service.detail('inc-1');
    expect(d.timeline).toEqual([{ id: 'l1' }]);
    prisma.incident.findUnique.mockResolvedValueOnce(null);
    await expect(service.detail('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Incident permissions', () => {
  function guard(perm: string, user: { permissions?: string[] }) {
    const reflector = { getAllAndOverride: () => [perm] };
    const g = new PermissionGuard(reflector as never);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ user }) }), getHandler: () => null, getClass: () => null } as never;
    return () => g.canActivate(ctx);
  }
  it('Incident.read gates reads; Incident.manage gates ack/resolve', () => {
    expect(guard('Incident.read', { permissions: ['Incident.read'] })()).toBe(true);
    expect(guard('Incident.read', { permissions: ['SystemLog.read'] })).toThrow(ForbiddenException);
    expect(guard('Incident.manage', { permissions: ['Incident.read'] })).toThrow(ForbiddenException);
    expect(guard('Incident.manage', { permissions: ['Incident.manage'] })()).toBe(true);
  });
});
