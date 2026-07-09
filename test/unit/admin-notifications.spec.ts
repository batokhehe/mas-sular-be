import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { buildAdminNotification, registerNotificationMapper, supportedNotificationEvents } from '../../src/infrastructure/admin-notifications/admin-notification.builder';
import { BellListQueryDto, ManualNotificationDto } from '../../src/modules/admin/application/dto/bell-query.dto';
import { AdminBellController } from '../../src/modules/admin/presentation/admin-bell.controller';
import { MetricsRegistry } from '../../src/infrastructure/metrics/metrics.registry';
import { AdminNotificationRepository } from '../../src/infrastructure/admin-notifications/admin-notification.repository';
import { AdminNotificationDispatcher } from '../../src/infrastructure/admin-notifications/admin-notification.dispatcher';
import { AdminNotificationConsumer } from '../../src/infrastructure/admin-notifications/admin-notification.consumer';
import { AdminNotificationMetrics } from '../../src/infrastructure/admin-notifications/admin-notification.metrics';
import { FirebasePushChannel } from '../../src/infrastructure/admin-notifications/push.channel';
import { SseHubService } from '../../src/infrastructure/admin-notifications/sse-hub.service';

describe('notification builder (pure)', () => {
  it('order.created → ORDER/HIGH with order number, total, and deep link', () => {
    const d = buildAdminNotification('order.created', { orderId: 'o1', orderNumber: 'BMS-20260709-001', totalPrice: 250000 });
    expect(d).toMatchObject({
      eventType: 'order.created', category: 'ORDER', priority: 'HIGH',
      title: 'New Order Received', url: '/orders/o1',
    });
    expect(d?.message).toContain('BMS-20260709-001');
    expect(d?.message).toContain('250.000');
  });

  it('maps the payment lifecycle + shipped/cancelled fan-out', () => {
    expect(buildAdminNotification('payment.receipt_uploaded', {})).toMatchObject({ eventType: 'payment.uploaded', priority: 'HIGH' });
    expect(buildAdminNotification('payment.paid', { orderId: 'o1', amount: 130321 })).toMatchObject({ eventType: 'payment.verified', url: '/orders/o1' });
    expect(buildAdminNotification('payment.failed', {})).toMatchObject({ eventType: 'payment.rejected', category: 'PAYMENT' });
    expect(buildAdminNotification('order.status_updated', { status: 'SHIPPED', orderId: 'o1' })).toMatchObject({ eventType: 'order.shipped' });
    expect(buildAdminNotification('order.status_updated', { status: 'CANCELLED' })).toMatchObject({ eventType: 'order.cancelled', priority: 'HIGH' });
    expect(buildAdminNotification('order.status_updated', { status: 'PROCESSING' })).toBeNull(); // routine hop
    expect(buildAdminNotification('stock.out', { productName: 'Bakso Urat' })?.message).toContain('Bakso Urat');
    expect(buildAdminNotification('system.error', { title: 'X', message: 'boom' })).toMatchObject({ priority: 'CRITICAL', category: 'SYSTEM' });
  });

  it('unknown events → null; future events plug in via registerNotificationMapper', () => {
    expect(buildAdminNotification('some.future.event', {})).toBeNull();
    registerNotificationMapper('promo.launched', (p) => ({
      eventType: 'promo.launched', category: 'ORDER', priority: 'LOW', title: 'Promo', message: String(p.code ?? ''), url: null, icon: null,
    }));
    expect(buildAdminNotification('promo.launched', { code: 'HEMAT' })?.message).toBe('HEMAT');
    expect(supportedNotificationEvents()).toContain('order.created');
  });
});

describe('repository', () => {
  function build() {
    const prisma = {
      admin: { findMany: jest.fn().mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]) },
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(4),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ id: 'n1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      pushSubscription: {
        upsert: jest.fn().mockResolvedValue({ id: 'ps1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ token: 't1', adminId: 'a1' }]),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { repo: new AdminNotificationRepository(prisma as any), prisma };
  }
  const draft = { eventType: 'order.created', category: 'ORDER' as const, priority: 'HIGH' as const, title: 'T', message: 'M', url: '/orders/o1', icon: null };

  it('fan-out create: one row per target admin in a single createMany', async () => {
    const { repo, prisma } = build();
    const created = await repo.createForAdmins(draft, ['a1', 'a2']);
    expect(created).toBe(2);
    const rows = prisma.notification.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { adminId: string }) => r.adminId)).toEqual(['a1', 'a2']);
  });

  it('cursor pagination: limit+1 probe, per-admin scope, unread/category filters', async () => {
    const { repo, prisma } = build();
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: `n${i}` }));
    prisma.notification.findMany.mockResolvedValue(rows);
    const page = await repo.list({ adminId: 'a1', limit: 20, unread: true, category: 'ORDER', cursor: 'n-prev' });
    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ adminId: 'a1', isRead: false, category: 'ORDER' });
    expect(args).toMatchObject({ take: 21, skip: 1, cursor: { id: 'n-prev' } });
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe('n19');
  });

  it('markRead is ownership-scoped; markAllRead returns the count', async () => {
    const { repo, prisma } = build();
    await repo.markRead('n1', 'a1');
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'n1', adminId: 'a1', isRead: false },
      data: expect.objectContaining({ isRead: true }),
    });
    prisma.notification.updateMany.mockResolvedValue({ count: 3 });
    expect(await repo.markAllRead('a1')).toEqual({ read: 3 });
  });

  it('cleanup prunes old notifications + stale tokens', async () => {
    const { repo, prisma } = build();
    prisma.notification.deleteMany = jest.fn().mockResolvedValue({ count: 9 });
    const result = await repo.cleanup(90, 60);
    expect(result).toEqual({ notifications: 9, tokens: 1 });
  });
});

describe('channels', () => {
  const draft = { eventType: 'x', category: 'ORDER' as const, priority: 'HIGH' as const, title: 'T', message: 'M', url: null, icon: null };

  it('sse hub: registers multiple tabs, broadcasts, cleans up on close', () => {
    const metrics = new AdminNotificationMetrics();
    const hub = new SseHubService(metrics);
    const makeRes = () => {
      const writes: string[] = [];
      const handlers: Record<string, () => void> = {};
      return {
        writes,
        setHeader: jest.fn(), flushHeaders: jest.fn(),
        write: (s: string) => writes.push(s),
        req: { on: (evt: string, cb: () => void) => { handlers[evt] = cb; } },
        close: () => handlers.close?.(),
        end: jest.fn(),
      };
    };
    const tab1 = makeRes(); const tab2 = makeRes(); const other = makeRes();
    hub.register('a1', tab1 as never);
    hub.register('a1', tab2 as never); // second tab, same admin
    hub.register('a2', other as never);
    expect(hub.activeConnections()).toBe(3);

    hub.broadcast(['a1'], 'notification.created', { title: 'T' });
    expect(tab1.writes.some((w) => w.includes('event: notification.created'))).toBe(true);
    expect(tab2.writes.some((w) => w.includes('event: notification.created'))).toBe(true);
    expect(other.writes.some((w) => w.includes('notification.created'))).toBe(false);

    tab1.close(); // connection cleanup
    expect(hub.activeConnections()).toBe(2);
    hub.onModuleDestroy();
  });

  it('push channel: invalid tokens purged, transient retried once, success/failed metrics', async () => {
    const repo = {
      tokensFor: jest.fn().mockResolvedValue([{ token: 'good' }, { token: 'dead' }, { token: 'flaky' }]),
      removeInvalidToken: jest.fn().mockResolvedValue(undefined),
    };
    const metrics = new AdminNotificationMetrics();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = new FirebasePushChannel(repo as any, metrics);
    const send = jest.fn()
      .mockImplementation(async (token: string) => (token === 'good' ? 'ok' : token === 'dead' ? 'invalid-token' : 'transient'));
    channel.setProvider({ send });

    await channel.dispatch({ ...draft }, ['a1']);
    expect(repo.removeInvalidToken).toHaveBeenCalledWith('dead'); // auto-purged
    expect(send.mock.calls.filter(([t]) => t === 'flaky')).toHaveLength(2); // one retry
    expect(metrics.snapshot()).toMatchObject({ pushSuccess: 1, pushFailed: 2 });
  });

  it('dispatcher: DB first, then SSE + push isolated (a failing channel never blocks)', async () => {
    const repo = { activeAdminIds: jest.fn().mockResolvedValue(['a1']), createForAdmins: jest.fn().mockResolvedValue(1) };
    const hub = { broadcast: jest.fn() };
    const push = { name: 'firebase-push', dispatch: jest.fn().mockRejectedValue(new Error('fcm down')) };
    const metrics = new AdminNotificationMetrics();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispatcher = new AdminNotificationDispatcher(repo as any, hub as any, push as any, metrics);
    const created = await dispatcher.dispatch({ ...draft });
    expect(created).toBe(1);
    expect(repo.createForAdmins).toHaveBeenCalled();
    expect(hub.broadcast).toHaveBeenCalledWith(['a1'], 'notification.created', expect.any(Object));
    expect(hub.broadcast).toHaveBeenCalledWith(['a1'], 'counter.updated', { delta: 1 });
    expect(metrics.snapshot().notificationsCreated).toBe(1); // push failure didn't block
  });
});

describe('worker (consumer processing)', () => {
  function build(seen = false) {
    const prisma = {
      processedEvent: {
        findUnique: jest.fn().mockResolvedValue(seen ? { messageId: 'm1' } : null),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const dispatcher = { dispatch: jest.fn().mockResolvedValue(2) };
    const metrics = new AdminNotificationMetrics();
    const consumer = new AdminNotificationConsumer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any, {} as any, dispatcher as any, metrics,
      { enabled: false, prefetch: 10, maxAttempts: 5, retryDelayMs: 1000 } as never,
    );
    return { consumer, prisma, dispatcher };
  }

  it('processes an event exactly once (ProcessedEvent marked BEFORE dispatch)', async () => {
    const { consumer, prisma, dispatcher } = build();
    const outcome = await consumer.process('m1', { name: 'order.created', payload: { orderId: 'o1', orderNumber: 'B', totalPrice: 1 } });
    expect(outcome).toBe('created');
    expect(prisma.processedEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ consumer: 'admin.notifications', messageId: 'm1' }) });
    expect(dispatcher.dispatch).toHaveBeenCalled();
  });

  it('duplicate messageId → no second notification (idempotent)', async () => {
    const { consumer, dispatcher } = build(true);
    expect(await consumer.process('m1', { name: 'order.created', payload: {} })).toBe('duplicate');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('non-notification events are deduped but skipped (no dispatch)', async () => {
    const { consumer, dispatcher, prisma } = build();
    expect(await consumer.process('m2', { name: 'order.status_updated', payload: { status: 'PROCESSING' } })).toBe('skipped');
    expect(prisma.processedEvent.create).toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ---------------- production hardening (this pass) ----------------

describe('SSE stream RBAC (token-claim authorization)', () => {
  const SECRET = 'test-stream-secret';
  const jwt = new JwtService({});

  function buildController(activeAdmin = true) {
    const prisma = { admin: { findFirst: jest.fn().mockResolvedValue(activeAdmin ? { id: 'a1' } : null) } };
    const hub = { register: jest.fn(), activeConnections: jest.fn().mockReturnValue(0) };
    const controller = new AdminBellController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any, {} as any, hub as any, new AdminNotificationMetrics(), prisma as any,
    );
    return { controller, hub, prisma };
  }

  beforeAll(() => {
    process.env.JWT_ADMIN_ACCESS_SECRET = SECRET;
  });

  it('registers the connection for an active admin holding Notification.read', async () => {
    const { controller, hub } = buildController();
    const token = jwt.sign({ sub: 'a1', permissions: ['Notification.read'] }, { secret: SECRET });
    await controller.stream({} as never, {} as never, token);
    expect(hub.register).toHaveBeenCalledWith('a1', expect.anything());
  });

  it('SUPER_ADMIN streams without an explicit grant', async () => {
    const { controller, hub } = buildController();
    const token = jwt.sign({ sub: 'a1', role: 'SUPER_ADMIN', permissions: [] }, { secret: SECRET });
    await controller.stream({} as never, {} as never, token);
    expect(hub.register).toHaveBeenCalled();
  });

  it('rejects a valid token WITHOUT Notification.read (RBAC gap closed)', async () => {
    const { controller, hub } = buildController();
    const token = jwt.sign({ sub: 'a1', role: 'OPS', permissions: ['Order.read'] }, { secret: SECRET });
    await expect(controller.stream({} as never, {} as never, token)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(hub.register).not.toHaveBeenCalled();
  });

  it('rejects forged/missing tokens and inactive admins', async () => {
    const { controller, hub } = buildController();
    await expect(controller.stream({} as never, {} as never, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.stream({} as never, {} as never, 'garbage.token.here')).rejects.toBeInstanceOf(UnauthorizedException);
    const forged = jwt.sign({ sub: 'a1', permissions: ['Notification.read'] }, { secret: 'wrong-secret' });
    await expect(controller.stream({} as never, {} as never, forged)).rejects.toBeInstanceOf(UnauthorizedException);

    const inactive = buildController(false);
    const token = jwt.sign({ sub: 'a1', permissions: ['Notification.read'] }, { secret: SECRET });
    await expect(inactive.controller.stream({} as never, {} as never, token)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(hub.register).not.toHaveBeenCalled();
  });
});

describe('bell DTO validation (malformed input → 400, never 500)', () => {
  it('rejects non-numeric / out-of-range limits that previously became take: NaN', () => {
    const bad = plainToInstance(BellListQueryDto, { limit: 'abc' }, { enableImplicitConversion: true });
    expect(validateSync(bad).length).toBeGreaterThan(0);
    const tooBig = plainToInstance(BellListQueryDto, { limit: '100' }, { enableImplicitConversion: true });
    expect(validateSync(tooBig).length).toBeGreaterThan(0);
    const ok = plainToInstance(BellListQueryDto, { limit: '20', unread: 'true', category: 'ORDER' }, { enableImplicitConversion: true });
    expect(validateSync(ok)).toHaveLength(0);
    expect(ok.limit).toBe(20);
    expect(ok.unread).toBe(true);
  });

  it('unread only accepts the literal "true" (implicit-conversion pitfall covered)', () => {
    const falsy = plainToInstance(BellListQueryDto, { unread: 'false' }, { enableImplicitConversion: true });
    expect(falsy.unread).toBe(false);
    expect(validateSync(falsy)).toHaveLength(0);
  });

  it('manual notification url must be an in-app relative path', () => {
    const base = { title: 'T', message: 'M' };
    expect(validateSync(plainToInstance(ManualNotificationDto, { ...base, url: '/orders/o1' }))).toHaveLength(0);
    expect(validateSync(plainToInstance(ManualNotificationDto, { ...base }))).toHaveLength(0); // url optional
    for (const url of ['https://evil.example', '//evil.example', 'javascript:alert(1)', 'orders/o1']) {
      expect(validateSync(plainToInstance(ManualNotificationDto, { ...base, url })).length).toBeGreaterThan(0);
    }
  });
});

describe('prom-client bridge (dual-emit observability)', () => {
  it('registers and increments platform metrics in the shared registry', async () => {
    const registry = new MetricsRegistry();
    const metrics = new AdminNotificationMetrics(registry);
    metrics.created(3);
    metrics.pushFailed();
    metrics.deadLettered();
    metrics.sseConnected();
    metrics.sseConnected();
    metrics.sseDisconnected();
    metrics.observeProcessing(120);

    const exposed = await registry.expose();
    expect(exposed).toContain('masular_admin_notifications_created_total 3');
    expect(exposed).toContain('masular_admin_push_failed_total 1');
    expect(exposed).toContain('masular_admin_notification_dead_lettered_total 1');
    expect(exposed).toContain('masular_admin_sse_connections 1');
    expect(exposed).toContain('masular_admin_notification_processing_seconds_count 1');
    // JSON snapshot (admin UI endpoint) stays in lockstep.
    expect(metrics.snapshot()).toMatchObject({ notificationsCreated: 3, pushFailed: 1, activeSseConnections: 1 });
  });

  it('still works standalone without a registry (unit-test seam preserved)', () => {
    const metrics = new AdminNotificationMetrics();
    metrics.created();
    expect(metrics.snapshot().notificationsCreated).toBe(1);
  });
});
