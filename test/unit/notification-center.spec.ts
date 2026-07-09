import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { NotificationCenterService } from '../../src/infrastructure/lifecycle/notification-center.service';
import { PermissionGuard } from '../../src/common/guards/permission.guard';

function sqlText(arg: unknown): string {
  if (arg && typeof arg === 'object' && Array.isArray((arg as { strings?: unknown }).strings)) {
    return (arg as { strings: string[] }).strings.join(' ');
  }
  return String(arg ?? '');
}

const CREATED = new Date('2026-07-07T10:00:00Z');
const SENT_AT = new Date('2026-07-07T10:00:12Z');
const ROW = {
  id: 'ntf-1', createdAt: CREATED, channel: 'WHATSAPP', template: 'order.transfer', recipient: '628123',
  status: 'SENT', attempts: 1, nextAttemptAt: CREATED, sentAt: SENT_AT, lastError: null,
  providerMessageId: 'q-1', sourceMessageId: 'msg-1', lockedUntil: null, lockedBy: null,
  payload: { orderId: 'o1', orderNumber: 'BMS-1', customerName: 'Jane', totalPrice: 135123 },
};

function queryRaw(arg: unknown): Promise<unknown[]> {
  const t = sqlText(arg);
  if (t.includes('avgDeliverySec'))
    return Promise.resolve([{ total: 100, pending: 5, sending: 2, sent: 80, failed: 15, sentToday: 8, failedToday: 2, avgDeliverySec: 12 }]);
  if (t.includes('DATE(createdAt)'))
    return Promise.resolve([{ day: '2026-07-06', sent: 10, failed: 1 }, { day: '2026-07-07', sent: 8, failed: 2 }]);
  return Promise.resolve([]);
}

function build() {
  const prisma = {
    $queryRaw: jest.fn().mockImplementation(queryRaw),
    notificationOutbox: {
      groupBy: jest.fn().mockImplementation((args: { by: string[] }) =>
        args.by[0] === 'channel'
          ? [{ channel: 'WHATSAPP', _count: { _all: 70 } }, { channel: 'EMAIL', _count: { _all: 30 } }]
          : [{ status: 'SENT', _count: { _all: 80 } }, { status: 'FAILED', _count: { _all: 15 } }],
      ),
      findMany: jest.fn().mockResolvedValue([ROW]),
      count: jest.fn().mockResolvedValue(41),
      findUnique: jest.fn().mockResolvedValue(ROW),
    },
  };
  const redrive = { redriveFailedNotifications: jest.fn().mockResolvedValue({ matched: 0, redriven: 1, dryRun: false }) };
  const cache = { get: jest.fn().mockResolvedValue(undefined), set: jest.fn(), del: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service: new NotificationCenterService(prisma as any, redrive as any, cache as any), prisma, redrive, cache };
}

describe('NotificationCenterService.overview', () => {
  it('aggregates totals, today success rate, avg delivery, charts, and recent failures', async () => {
    const { service } = build();
    const d = await service.computeOverview();
    expect(d.summary).toMatchObject({ total: 100, pending: 5, sending: 2, sent: 80, failed: 15, todaySuccessRatePct: 80, avgDeliverySec: 12 });
    expect(d.byChannel).toEqual(expect.arrayContaining([{ key: 'WHATSAPP', count: 70 }, { key: 'EMAIL', count: 30 }]));
    expect(d.byStatus).toEqual(expect.arrayContaining([{ key: 'SENT', count: 80 }]));
    expect(d.trend).toHaveLength(2);
    expect(d.failures[0]).toMatchObject({ id: 'ntf-1' });
  });

  it('caches the overview for 30s and serves the cached payload on a hit', async () => {
    const { service, cache, prisma } = build();
    await service.overview();
    expect(cache.set).toHaveBeenCalledWith('admin:notification-center', expect.any(Object), 30_000);
    cache.get.mockResolvedValue({ cached: true });
    expect(await service.overview()).toEqual({ cached: true });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2); // only the first compute
  });
});

describe('NotificationCenterService.list — filters + rows', () => {
  it('paginates newest-first; rows carry derived subject, delivery duration, and related refs', async () => {
    const { service, prisma } = build();
    const res = await service.list({ page: 2, limit: 10 });
    expect(prisma.notificationOutbox.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10, orderBy: { createdAt: 'desc' } }));
    expect(res).toEqual(expect.objectContaining({ page: 2, limit: 10, total: 41, totalPages: 5 }));
    expect(res.items[0]).toMatchObject({
      id: 'ntf-1',
      subject: expect.stringContaining('BMS-1'), // rendered via the existing TemplateRenderer
      deliverySec: 12,
      related: { orderId: 'o1', orderNumber: 'BMS-1' },
    });
  });

  it('filters: channel/status/template/recipient/date + order/payment via payload JSON', () => {
    const { service } = build();
    const from = new Date('2026-07-01'); const to = new Date('2026-07-07');
    const where = service.buildWhere({
      channel: 'EMAIL' as never, status: 'FAILED' as never, template: 'order', recipient: 'jane',
      order: 'o1', payment: 'pay-1', dateFrom: from, dateTo: to,
    });
    expect(where).toMatchObject({
      channel: 'EMAIL', status: 'FAILED',
      template: { contains: 'order' }, recipient: { contains: 'jane' },
      createdAt: { gte: from, lte: to },
      AND: [{ payload: { string_contains: 'o1' } }, { payload: { string_contains: 'pay-1' } }],
    });
  });

  it('search ORs id/recipient/template/source/provider ids + payload JSON', () => {
    const { service } = build();
    const where = service.buildWhere({ search: 'BMS-1' });
    expect(where.OR).toEqual(expect.arrayContaining([
      { id: 'BMS-1' }, { recipient: { contains: 'BMS-1' } }, { payload: { string_contains: 'BMS-1' } },
    ]));
  });
});

describe('NotificationCenterService.detail', () => {
  it('returns the row + rendered subject/body + provider response + retry history + related', async () => {
    const { service } = build();
    const d = await service.detail('ntf-1');
    expect(d.notification).toMatchObject({ id: 'ntf-1', deliverySec: 12 });
    expect(d.rendered?.subject).toContain('BMS-1');
    expect(d.providerResponse).toEqual({ providerMessageId: 'q-1', lastError: null });
    expect(d.retryHistory).toMatchObject({ attempts: 1, sentAt: SENT_AT.toISOString() });
    expect(d.related.orderId).toBe('o1');
  });

  it('404s for an unknown id', async () => {
    const { service, prisma } = build();
    prisma.notificationOutbox.findUnique.mockResolvedValueOnce(null);
    await expect(service.detail('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('NotificationCenterService.resend — delegates to the existing redrive flow', () => {
  it('FAILED → redriveFailedNotifications({ id }) + overview cache invalidated', async () => {
    const { service, prisma, redrive, cache } = build();
    prisma.notificationOutbox.findUnique.mockResolvedValueOnce({ id: 'ntf-1', status: 'FAILED' });
    const res = await service.resend('ntf-1');
    expect(redrive.redriveFailedNotifications).toHaveBeenCalledWith({ id: 'ntf-1' });
    expect(cache.del).toHaveBeenCalledWith('admin:notification-center');
    expect(res.redriven).toBe(1);
  });

  it('rejects non-FAILED (400) and missing (404) without touching the redrive', async () => {
    const { service, prisma, redrive } = build();
    prisma.notificationOutbox.findUnique.mockResolvedValueOnce({ id: 'ntf-1', status: 'SENT' });
    await expect(service.resend('ntf-1')).rejects.toBeInstanceOf(BadRequestException);
    prisma.notificationOutbox.findUnique.mockResolvedValueOnce(null);
    await expect(service.resend('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(redrive.redriveFailedNotifications).not.toHaveBeenCalled();
  });
});

describe('Notification Center permissions', () => {
  function guard(perm: string, user: { permissions?: string[] }) {
    const reflector = { getAllAndOverride: () => [perm] };
    const g = new PermissionGuard(reflector as never);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ user }) }), getHandler: () => null, getClass: () => null } as never;
    return () => g.canActivate(ctx);
  }
  it('Notification.read gates reads; Notification.resend gates resend', () => {
    expect(guard('Notification.read', { permissions: ['Notification.read'] })()).toBe(true);
    expect(guard('Notification.read', { permissions: ['Queue.read'] })).toThrow(ForbiddenException);
    expect(guard('Notification.resend', { permissions: ['Notification.read'] })).toThrow(ForbiddenException);
    expect(guard('Notification.resend', { permissions: ['Notification.resend'] })()).toBe(true);
  });
});
