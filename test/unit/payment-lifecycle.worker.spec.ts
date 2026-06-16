import { PaymentLifecycleWorker } from '../../src/modules/payments/payment-lifecycle.worker';
import { PaymentLifecycleConfig, loadPaymentLifecycleConfig } from '../../src/modules/payments/payment-lifecycle.config';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

const ORDER = { id: 'order-1', orderNumber: 'BN-1', user: { email: 'jane@example.com', name: 'Jane' } };

function cfg(over: Partial<PaymentLifecycleConfig> = {}): PaymentLifecycleConfig {
  return {
    enabled: true,
    pollIntervalMs: 300_000,
    initialDelayMs: 60_000,
    batchSize: 100,
    firstReminderAfterMs: 12 * HOUR,
    secondReminderAfterMs: 20 * HOUR,
    expiryAfterMs: 24 * HOUR,
    gatewayExpiryAfterMs: 24 * HOUR,
    ...over,
  };
}

function payment(over: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    orderId: 'order-1',
    method: 'BANK_TRANSFER',
    amount: 50000,
    status: 'PENDING',
    createdAt: new Date(NOW - 100 * HOUR), // well past every window
    firstReminderAt: null,
    secondReminderAt: null,
    ...over,
  };
}

function build(config = cfg()) {
  const tx = {
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    order: { findUnique: jest.fn().mockResolvedValue(ORDER) },
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
  const uploadTokens = { issue: jest.fn().mockResolvedValue({ rawToken: 'raw', uploadUrl: 'https://app/payments/upload/raw', expiresAt: new Date() }) };
  const cancellation = { cancelAndRestock: jest.fn().mockResolvedValue({ cancelled: true }) };
  const metrics = { reminder: jest.fn(), paymentExpired: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const worker = new PaymentLifecycleWorker(prisma as any, uploadTokens as any, cancellation as any, metrics as any, config);
  (worker as any).nowMs = () => NOW;
  return { worker, prisma, tx, uploadTokens, cancellation, metrics };
}

describe('PaymentLifecycleWorker — expiry', () => {
  it('expires a non-COD payment: CAS→EXPIRED, cancels+restocks order, emits payment.expired once', async () => {
    const { worker, tx, cancellation, metrics } = build();

    const result = await worker.expirePayment(payment() as any);

    expect(result).toBe(true);
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: { in: ['PENDING', 'WAITING_VERIFICATION'] } },
      data: { status: 'EXPIRED' },
    });
    expect(cancellation.cancelAndRestock).toHaveBeenCalledWith(tx, 'order-1', expect.any(String)); // inventory restoration
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventName: 'payment.expired',
        routingKey: 'payment.expired',
        payload: { paymentId: 'pay-1', orderId: 'order-1' },
      }),
    });
    expect(metrics.paymentExpired).toHaveBeenCalledTimes(1);
  });

  it('concurrency/idempotency: a lost CAS (count 0) does nothing — no cancel, no event, no metric', async () => {
    const { worker, tx, cancellation, metrics } = build();
    tx.payment.updateMany.mockResolvedValue({ count: 0 });

    expect(await worker.expirePayment(payment() as any)).toBe(false);
    expect(cancellation.cancelAndRestock).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(metrics.paymentExpired).not.toHaveBeenCalled();
  });

  it('runExpiry applies the per-method window and skips not-yet-due / never-expiring rows', async () => {
    const { worker, prisma, metrics } = build(cfg({ gatewayExpiryAfterMs: 0 }));
    prisma.payment.findMany.mockResolvedValue([
      payment({ id: 'bt-due', method: 'BANK_TRANSFER', createdAt: new Date(NOW - 100 * HOUR) }), // due
      payment({ id: 'bt-young', method: 'BANK_TRANSFER', createdAt: new Date(NOW - 1 * HOUR) }), // < 72h
      payment({ id: 'gw', method: 'GATEWAY', createdAt: new Date(NOW - 100 * HOUR) }), // gateway disabled → never
    ]);

    const expired = await worker.runExpiry();

    expect(expired).toBe(1); // only bt-due
    expect(metrics.paymentExpired).toHaveBeenCalledTimes(1);
  });
});

describe('PaymentLifecycleWorker — reminders', () => {
  it('first reminder: claims the slot, mints a fresh token, emits a payment.reminder event', async () => {
    const { worker, tx, uploadTokens, metrics } = build();

    const result = await worker.sendReminder(payment() as any, 'first');

    expect(result).toBe(true);
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: { in: ['PENDING', 'WAITING_VERIFICATION'] }, firstReminderAt: null },
      data: { firstReminderAt: expect.any(Date) },
    });
    expect(uploadTokens.issue).toHaveBeenCalledWith(tx, 'pay-1'); // fresh token reissue
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventName: 'payment.reminder',
        routingKey: 'payment.reminder',
        payload: expect.objectContaining({
          paymentId: 'pay-1',
          orderId: 'order-1',
          stage: 'first',
          paymentMethod: 'BANK_TRANSFER',
          amount: 50000,
          uploadUrl: 'https://app/payments/upload/raw',
        }),
        metadata: expect.objectContaining({ source: 'payment.lifecycle.reminder' }),
      }),
    });
    expect(metrics.reminder).toHaveBeenCalledWith('first');
  });

  it('second reminder: claims secondReminderAt and emits a stage=second event', async () => {
    const { worker, tx, metrics } = build();

    await worker.sendReminder(payment({ firstReminderAt: new Date(NOW - 12 * HOUR) }) as any, 'second');

    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: { in: ['PENDING', 'WAITING_VERIFICATION'] }, secondReminderAt: null },
      data: { secondReminderAt: expect.any(Date) },
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventName: 'payment.reminder',
        payload: expect.objectContaining({ stage: 'second' }),
      }),
    });
    expect(metrics.reminder).toHaveBeenCalledWith('second');
  });

  it('dedup/concurrency: a lost reminder CAS (count 0) issues no token and emits no event', async () => {
    const { worker, tx, uploadTokens, metrics } = build();
    tx.payment.updateMany.mockResolvedValue({ count: 0 });

    expect(await worker.sendReminder(payment() as any, 'first')).toBe(false);
    expect(uploadTokens.issue).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(metrics.reminder).not.toHaveBeenCalled();
  });

  it('runReminders queries first-due (firstReminderAt null, +12h) and second-due (+20h) slices', async () => {
    const { worker, prisma } = build();
    await worker.runReminders();

    const firstWhere = prisma.payment.findMany.mock.calls[0][0].where;
    expect(firstWhere.firstReminderAt).toBeNull();
    expect(firstWhere.method).toEqual({ in: ['BANK_TRANSFER', 'QRIS'] });
    expect((firstWhere.createdAt.lte as Date).getTime()).toBe(NOW - 12 * HOUR);

    const secondWhere = prisma.payment.findMany.mock.calls[1][0].where;
    expect(secondWhere.firstReminderAt).toEqual({ not: null });
    expect(secondWhere.secondReminderAt).toBeNull();
    expect((secondWhere.createdAt.lte as Date).getTime()).toBe(NOW - 20 * HOUR);
  });
});

describe('PaymentLifecycleWorker — lifecycle gating', () => {
  it('does not schedule when disabled', () => {
    const { worker } = build(cfg({ enabled: false }));
    worker.onApplicationBootstrap();
    expect((worker as any).timer).toBeNull();
  });
});

describe('loadPaymentLifecycleConfig', () => {
  it('defaults disabled with 12h/20h reminders and 24h expiry', () => {
    const c = loadPaymentLifecycleConfig({});
    expect(c.enabled).toBe(false);
    expect(c.firstReminderAfterMs).toBe(12 * HOUR);
    expect(c.secondReminderAfterMs).toBe(20 * HOUR);
    expect(c.expiryAfterMs).toBe(24 * HOUR);
    expect(c.gatewayExpiryAfterMs).toBe(24 * HOUR);
  });

  it('parses overrides and allows gateway expiry to be disabled with 0', () => {
    const c = loadPaymentLifecycleConfig({ PAYMENT_LIFECYCLE_ENABLED: 'true', PAYMENT_GATEWAY_EXPIRY_MS: '0' });
    expect(c.enabled).toBe(true);
    expect(c.gatewayExpiryAfterMs).toBe(0);
  });
});
