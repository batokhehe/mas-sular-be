import { Prisma } from '@prisma/client';
import { PaymentNotificationConsumer } from '../../src/infrastructure/consumers/payment-notification.consumer';
import { ConsumersConfig } from '../../src/infrastructure/consumers/consumers.config';

const CONFIG: ConsumersConfig = { enabled: true, rabbitmqUrl: 'amqp://localhost', prefetch: 10, maxAttempts: 5, retryDelayMs: 30_000 };
const ORDER = { id: 'order-1', orderNumber: 'BMS-1', user: { email: 'jane@example.com', name: 'Jane' } };
const PAID = { name: 'payment.paid', payload: { paymentId: 'pay-1', orderId: 'order-1', amount: 50000 } };
const FAILED = { name: 'payment.failed', payload: { paymentId: 'pay-1', orderId: 'order-1' } };

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '6.19.3' });
}

function buildPrisma(over: { seen?: unknown; order?: unknown; txFail?: Error } = {}) {
  const tx = { notificationOutbox: { create: jest.fn().mockResolvedValue({}) }, processedEvent: { create: jest.fn() } };
  tx.processedEvent.create.mockImplementation(() => (over.txFail ? Promise.reject(over.txFail) : Promise.resolve({})));
  return {
    processedEvent: { findUnique: jest.fn().mockResolvedValue(over.seen ?? null) },
    order: { findUnique: jest.fn().mockResolvedValue('order' in over ? over.order : ORDER) },
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
}

function buildMetrics() {
  return {
    enqueued: jest.fn(), duplicate: jest.fn(), skipped: jest.fn(), consumerRetried: jest.fn(),
    deadLettered: jest.fn(), consumerPaused: jest.fn(), consumerResumed: jest.fn(),
  };
}

function build(prisma = buildPrisma(), config = CONFIG) {
  const rabbit = { createConsumerChannel: jest.fn() };
  const metrics = buildMetrics();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const consumer = new PaymentNotificationConsumer(prisma as any, rabbit as any, metrics as any, config);
  return { consumer, prisma, metrics };
}

describe('PaymentNotificationConsumer', () => {
  it('payment.paid → enqueues a payment.approved NotificationOutbox + ProcessedEvent in one tx', async () => {
    const { consumer, prisma } = build();
    const outcome = await consumer.process('evt-1', PAID);
    expect(outcome).toBe('enqueued');
    expect(prisma.__tx.notificationOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        channel: 'EMAIL',
        recipient: 'jane@example.com',
        template: 'payment.approved',
        sourceMessageId: 'evt-1',
        payload: expect.objectContaining({ orderId: 'order-1', orderNumber: 'BMS-1', customerName: 'Jane', amount: 50000 }),
      }),
    });
    expect(prisma.__tx.processedEvent.create).toHaveBeenCalledWith({
      data: { consumer: 'payment.notifications', messageId: 'evt-1', eventName: 'payment.paid' },
    });
  });

  it('payment.failed → enqueues a payment.rejected NotificationOutbox', async () => {
    const { consumer, prisma } = build();
    const outcome = await consumer.process('evt-2', FAILED);
    expect(outcome).toBe('enqueued');
    expect(prisma.__tx.notificationOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ template: 'payment.rejected', recipient: 'jane@example.com', sourceMessageId: 'evt-2' }),
    });
  });

  it('payment.reminder → enqueues a payment.reminder NotificationOutbox to the customer with the upload link', async () => {
    const { consumer, prisma } = build();
    const outcome = await consumer.process('evt-r', {
      name: 'payment.reminder',
      payload: { paymentId: 'pay-1', orderId: 'order-1', stage: 'first', paymentMethod: 'BANK_TRANSFER', amount: 50000, uploadUrl: 'https://app/payments/upload/raw' },
    })
    expect(outcome).toBe('enqueued')
    expect(prisma.__tx.notificationOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        template: 'payment.reminder',
        recipient: 'jane@example.com',
        sourceMessageId: 'evt-r',
        payload: expect.objectContaining({ uploadUrl: 'https://app/payments/upload/raw', stage: 'first', paymentMethod: 'BANK_TRANSFER' }),
      }),
    })
  });

  it('payment.expired → enqueues a payment.expired NotificationOutbox', async () => {
    const { consumer, prisma } = build();
    const outcome = await consumer.process('evt-3', { name: 'payment.expired', payload: { paymentId: 'pay-1', orderId: 'order-1' } });
    expect(outcome).toBe('enqueued');
    expect(prisma.__tx.notificationOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ template: 'payment.expired', recipient: 'jane@example.com', sourceMessageId: 'evt-3' }),
    });
  });

  it('payment.receipt_uploaded → notifies the configured admin inbox (not the customer)', async () => {
    const { consumer, prisma } = build(buildPrisma(), { ...CONFIG, adminNotificationEmail: 'ops@masular.test' });
    const outcome = await consumer.process('evt-4', { name: 'payment.receipt_uploaded', payload: { paymentId: 'pay-1', orderId: 'order-1' } });
    expect(outcome).toBe('enqueued');
    expect(prisma.__tx.notificationOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ template: 'payment.receipt_uploaded', recipient: 'ops@masular.test', sourceMessageId: 'evt-4' }),
    });
  });

  it('payment.receipt_uploaded → skips when no admin email is configured', async () => {
    const { consumer, prisma } = build(); // CONFIG has no adminNotificationEmail
    expect(await consumer.process('evt-5', { name: 'payment.receipt_uploaded', payload: { orderId: 'order-1' } })).toBe('skipped');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fast-path duplicate → no work', async () => {
    const { consumer, prisma } = build(buildPrisma({ seen: { messageId: 'evt-1' } }));
    expect(await consumer.process('evt-1', PAID)).toBe('duplicate');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('race duplicate (P2002) → duplicate', async () => {
    expect(await build(buildPrisma({ txFail: p2002() })).consumer.process('evt-1', PAID)).toBe('duplicate');
  });

  it('skips an event with no mapped template', async () => {
    const { consumer, prisma } = build();
    expect(await consumer.process('evt-1', { name: 'payment.receipt_uploaded', payload: { orderId: 'order-1' } })).toBe('skipped');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips when orderId missing or order/recipient gone', async () => {
    expect(await build().consumer.process('evt-1', { name: 'payment.paid', payload: {} })).toBe('skipped');
    expect(await build(buildPrisma({ order: null })).consumer.process('evt-1', PAID)).toBe('skipped');
  });
});
