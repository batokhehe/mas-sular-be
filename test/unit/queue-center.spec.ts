import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { QueueCenterService } from '../../src/infrastructure/lifecycle/queue-center.service';
import { extractRelated, queueHealth } from '../../src/infrastructure/lifecycle/queue-center.util';
import { PermissionGuard } from '../../src/common/guards/permission.guard';

function sqlText(arg: unknown): string {
  if (arg && typeof arg === 'object' && Array.isArray((arg as { strings?: unknown }).strings)) {
    return (arg as { strings: string[] }).strings.join(' ');
  }
  return String(arg ?? '');
}

const RECENT = new Date(Date.now() - 60_000);

const OUTBOX_ROW = {
  id: 'evt-1', createdAt: RECENT, eventName: 'payment.paid', eventVersion: 1,
  aggregateType: 'payment', aggregateId: 'pay-1', exchange: 'payments', routingKey: 'payment.paid',
  status: 'FAILED', attempts: 10, maxAttempts: 10, nextAttemptAt: RECENT, publishedAt: null,
  lastError: 'broker down', payload: { paymentId: 'pay-1', orderId: 'o1' }, metadata: { source: 'admin.verifyPayment' },
  lockedUntil: null, lockedBy: null, occurredAt: RECENT,
};
const NOTIF_ROW = {
  id: 'ntf-1', createdAt: RECENT, channel: 'WHATSAPP', template: 'order.transfer', recipient: '628123',
  status: 'FAILED', attempts: 8, nextAttemptAt: RECENT, sentAt: null, lastError: 'rate limited',
  providerMessageId: null, sourceMessageId: 'msg-1', payload: { orderId: 'o1', orderNumber: 'BMS-1' },
  lockedUntil: null, lockedBy: null,
};

function queryRaw(arg: unknown): Promise<unknown[]> {
  const t = sqlText(arg);
  if (t.includes('FROM `OutboxEvent`') && t.includes('avgPublishMs'))
    return Promise.resolve([{ pending: 4, processing: 1, published: 100, failed: 2, retrying: 3, oldestPending: RECENT, lastActivity: RECENT, lastFailure: RECENT, avgPublishMs: 250 }]);
  if (t.includes('FROM `NotificationOutbox`') && t.includes('avgPublishMs'))
    return Promise.resolve([{ pending: 6, processing: 0, published: 50, failed: 1, retrying: 2, oldestPending: RECENT, lastActivity: RECENT, lastFailure: null, avgPublishMs: 900 }]);
  if (t.includes("module LIKE 'worker.%'"))
    return Promise.resolve([{ module: 'worker.payment-lifecycle', success: 12, failure: 0, lastSuccess: RECENT, lastFailure: null, heartbeat: RECENT, avgMs: 20 }]);
  if (t.includes('lastSuccess')) return Promise.resolve([{ lastSuccess: RECENT, lastFailure: null, success: 100, failure: 2 }]);
  return Promise.resolve([]);
}

function build() {
  const prisma = {
    $queryRaw: jest.fn().mockImplementation(queryRaw),
    outboxEvent: {
      findMany: jest.fn().mockResolvedValue([OUTBOX_ROW]),
      count: jest.fn().mockResolvedValue(41),
      findUnique: jest.fn().mockResolvedValue({ id: 'evt-1', status: 'FAILED' }),
    },
    notificationOutbox: {
      findMany: jest.fn().mockResolvedValue([NOTIF_ROW]),
      count: jest.fn().mockResolvedValue(7),
      findUnique: jest.fn().mockResolvedValue({ id: 'ntf-1', status: 'FAILED' }),
    },
  };
  const redrive = {
    redriveFailedOutboxEvents: jest.fn().mockResolvedValue({ matched: 0, redriven: 1, dryRun: false }),
    redriveFailedNotifications: jest.fn().mockResolvedValue({ matched: 0, redriven: 1, dryRun: false }),
  };
  const cache = { get: jest.fn().mockResolvedValue(undefined), set: jest.fn(), del: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new QueueCenterService(prisma as any, redrive as any, cache as any, undefined);
  return { service, prisma, redrive, cache };
}

describe('queue-center.util', () => {
  it('extractRelated pulls entity refs from a payload (drawer links)', () => {
    expect(extractRelated({ orderId: 'o1', paymentId: 'p1', orderNumber: 'BMS-1', requestId: 'req-1', junk: 1 })).toEqual({
      requestId: 'req-1', orderId: 'o1', orderNumber: 'BMS-1', paymentId: 'p1', shipmentId: null, customerId: null,
    });
    expect(extractRelated(null).orderId).toBeNull();
  });

  it('queueHealth thresholds: green → yellow → red', () => {
    expect(queueHealth(0, 0)).toBe('green');
    expect(queueHealth(150, 0)).toBe('yellow');
    expect(queueHealth(0, 5)).toBe('yellow');
    expect(queueHealth(2000, 0)).toBe('red');
    expect(queueHealth(0, 100)).toBe('red');
  });
});

describe('QueueCenterService.compute (aggregation)', () => {
  it('summary combines outbox + notification stats with health + avg publish time', async () => {
    const { service } = build();
    const d = await service.compute();
    expect(d.summary).toMatchObject({
      pendingEvents: 10, processing: 1, published: 150, failed: 3, retrying: 5, deadLetters: 3, avgPublishMs: 250, health: 'yellow',
    });
    expect(d.outbox).toMatchObject({ pending: 4, failed: 2, avgPublishMs: 250 });
    expect(d.notifications).toMatchObject({ pending: 6, failed: 1 });
    expect(d.rabbitmq).toMatchObject({ configured: !!process.env.RABBITMQ_URL === true ? true : false, metricsAvailable: false });
    expect(Array.isArray(d.workers)).toBe(true);
    expect(d.deadLetters.outbox[0]).toMatchObject({ id: 'evt-1', lastError: 'broker down', related: { orderId: 'o1', paymentId: 'pay-1' } });
    expect(typeof d.deadLetters.outbox[0].ageMs).toBe('number');
  });

  it('overview caches for 30s and serves the cached payload on a hit', async () => {
    const { service, cache, prisma } = build();
    await service.overview();
    expect(cache.set).toHaveBeenCalledWith('admin:queue-center', expect.any(Object), 30_000);
    cache.get.mockResolvedValue({ cached: true });
    expect(await service.overview()).toEqual({ cached: true });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(5); // only the first compute
  });
});

describe('QueueCenterService lists (pagination + filters + search)', () => {
  it('listOutbox paginates newest-first and shapes rows with related refs', async () => {
    const { service, prisma } = build();
    const res = await service.listOutbox({ page: 2, limit: 10 });
    expect(prisma.outboxEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10, orderBy: { createdAt: 'desc' } }));
    expect(res).toEqual(expect.objectContaining({ page: 2, limit: 10, total: 41, totalPages: 5 }));
    expect(res.items[0]).toMatchObject({ id: 'evt-1', eventName: 'payment.paid', related: { orderId: 'o1', paymentId: 'pay-1' } });
  });

  it('outbox filters narrow the where clause (status/event/aggregate/date)', () => {
    const { service } = build();
    const from = new Date('2026-07-01'); const to = new Date('2026-07-07');
    const where = service.buildOutboxWhere({ status: 'FAILED' as never, event: 'payment', aggregate: 'order', dateFrom: from, dateTo: to });
    expect(where).toMatchObject({
      status: 'FAILED', eventName: { contains: 'payment' }, aggregateType: { contains: 'order' }, createdAt: { gte: from, lte: to },
    });
  });

  it('search matches ids, event/routing key, and the JSON payload (order number / phone / email)', () => {
    const { service } = build();
    const where = service.buildOutboxWhere({ search: 'BMS-1' });
    expect(where.OR).toEqual(expect.arrayContaining([
      { id: 'BMS-1' }, { aggregateId: 'BMS-1' }, { payload: { string_contains: 'BMS-1' } },
    ]));
    const nWhere = service.buildNotificationWhere({ search: '628123' });
    expect(nWhere.OR).toEqual(expect.arrayContaining([
      { recipient: { contains: '628123' } }, { payload: { string_contains: '628123' } },
    ]));
  });

  it('notification filters: channel/status/template', () => {
    const { service } = build();
    const where = service.buildNotificationWhere({ channel: 'WHATSAPP' as never, status: 'FAILED' as never, template: 'order.transfer' });
    expect(where).toMatchObject({ channel: 'WHATSAPP', status: 'FAILED', template: { contains: 'order.transfer' } });
  });
});

describe('QueueCenterService retries (delegate to RedriveService)', () => {
  it('retryOutbox: FAILED row → redrive by id + cache invalidated', async () => {
    const { service, redrive, cache } = build();
    const res = await service.retryOutbox('evt-1');
    expect(redrive.redriveFailedOutboxEvents).toHaveBeenCalledWith({ id: 'evt-1' });
    expect(cache.del).toHaveBeenCalledWith('admin:queue-center');
    expect(res.redriven).toBe(1);
  });

  it('retryOutbox: 404 on missing, 400 on non-FAILED', async () => {
    const { service, prisma, redrive } = build();
    prisma.outboxEvent.findUnique.mockResolvedValueOnce(null);
    await expect(service.retryOutbox('missing')).rejects.toBeInstanceOf(NotFoundException);
    prisma.outboxEvent.findUnique.mockResolvedValueOnce({ id: 'evt-1', status: 'PUBLISHED' });
    await expect(service.retryOutbox('evt-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(redrive.redriveFailedOutboxEvents).not.toHaveBeenCalled();
  });

  it('retryNotification: FAILED row → redrive by id', async () => {
    const { service, redrive } = build();
    await service.retryNotification('ntf-1');
    expect(redrive.redriveFailedNotifications).toHaveBeenCalledWith({ id: 'ntf-1' });
  });

  it('retryAllFailed: target routes to one or both redrives', async () => {
    const { service, redrive } = build();
    await service.retryAllFailed('outbox');
    expect(redrive.redriveFailedOutboxEvents).toHaveBeenCalledWith({});
    expect(redrive.redriveFailedNotifications).not.toHaveBeenCalled();
    await service.retryAllFailed('all');
    expect(redrive.redriveFailedNotifications).toHaveBeenCalledWith({});
  });
});

describe('Queue Center permissions', () => {
  function guard(perm: string, user: { role?: string; permissions?: string[] }) {
    const reflector = { getAllAndOverride: () => [perm] };
    const g = new PermissionGuard(reflector as never);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ user }) }), getHandler: () => null, getClass: () => null } as never;
    return () => g.canActivate(ctx);
  }
  it('Queue.read gates reads; Queue.retry gates retries (read alone is not enough)', () => {
    expect(guard('Queue.read', { permissions: ['Queue.read'] })()).toBe(true);
    expect(guard('Queue.read', { permissions: ['Dashboard.read'] })).toThrow(ForbiddenException);
    expect(guard('Queue.retry', { permissions: ['Queue.read'] })).toThrow(ForbiddenException);
    expect(guard('Queue.retry', { permissions: ['Queue.retry'] })()).toBe(true);
  });
});
