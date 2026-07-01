import { Prisma } from '@prisma/client';
import {
  OrderCreatedNotificationConsumer,
  countDeaths,
  isInfraError,
} from '../../src/infrastructure/consumers/order-created-notification.consumer';
import { ConsumersConfig } from '../../src/infrastructure/consumers/consumers.config';

const CONFIG: ConsumersConfig = { enabled: true, rabbitmqUrl: 'amqp://localhost', prefetch: 10, maxAttempts: 5, retryDelayMs: 30_000 };
const ORDER = {
  id: 'order-1',
  orderNumber: 'BMS-1',
  totalPrice: 30000,
  paymentMethod: 'BANK_TRANSFER',
  user: { email: 'jane@example.com', name: 'Jane', phone: null },
  address: { phone: '08123456789' },
};
const EVENT = {
  name: 'order.created',
  payload: { orderId: 'order-1', orderNumber: 'BMS-1', totalPrice: 30000, uploadUrl: 'https://app/payment/rawtoken' },
};

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '6.19.3' });
}
function p1001() {
  return new Prisma.PrismaClientKnownRequestError('Cannot reach DB', { code: 'P1001', clientVersion: '6.19.3' });
}

function buildPrisma(over: { seen?: unknown; order?: unknown; txFail?: Error; findFail?: Error } = {}) {
  const tx = { notificationOutbox: { create: jest.fn().mockResolvedValue({}) }, processedEvent: { create: jest.fn() } };
  tx.processedEvent.create.mockImplementation(() => (over.txFail ? Promise.reject(over.txFail) : Promise.resolve({})));
  const orderFind = jest.fn();
  orderFind.mockImplementation(() => (over.findFail ? Promise.reject(over.findFail) : Promise.resolve('order' in over ? over.order : ORDER)));
  return {
    processedEvent: { findUnique: jest.fn().mockResolvedValue(over.seen ?? null) },
    order: { findUnique: orderFind },
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
  const consumer = new OrderCreatedNotificationConsumer(prisma as any, rabbit as any, metrics as any, config);
  return { consumer, prisma, rabbit, metrics };
}

function msg(props: Record<string, unknown> = {}, content = JSON.stringify(EVENT)) {
  return { content: Buffer.from(content), properties: { messageId: 'evt-1', headers: {}, ...props } } as any;
}

function fakeChannel(opts: { confirmFails?: boolean } = {}) {
  return {
    ack: jest.fn(),
    nack: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue({ consumerTag: 't' }),
    sendToQueue: jest.fn((_q: string, _c: Buffer, _o: unknown, cb: (e: unknown) => void) =>
      cb(opts.confirmFails ? new Error('confirm failed') : null),
    ),
  };
}

describe('OrderCreatedNotificationConsumer', () => {
  describe('process — exactly-once enqueue', () => {
    it('enqueues NotificationOutbox + ProcessedEvent in one transaction', async () => {
      const { consumer, prisma } = build();
      const outcome = await consumer.process('evt-1', EVENT);
      expect(outcome).toBe('enqueued');
      expect(prisma.__tx.notificationOutbox.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ channel: 'WHATSAPP', recipient: '08123456789', template: 'order.transfer', sourceMessageId: 'evt-1' }),
      });
      expect(prisma.__tx.processedEvent.create).toHaveBeenCalledWith({
        data: { consumer: 'order.notifications', messageId: 'evt-1', eventName: 'order.created' },
      });
    });

    it('fast-path duplicate → no work', async () => {
      const { consumer, prisma } = build(buildPrisma({ seen: { messageId: 'evt-1' } }));
      expect(await consumer.process('evt-1', EVENT)).toBe('duplicate');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('race duplicate (P2002) → duplicate', async () => {
      expect(await build(buildPrisma({ txFail: p2002() })).consumer.process('evt-1', EVENT)).toBe('duplicate');
    });

    it('skips when orderId missing or order/recipient gone', async () => {
      expect(await build().consumer.process('evt-1', { name: 'order.created', payload: {} })).toBe('skipped');
      expect(await build(buildPrisma({ order: null })).consumer.process('evt-1', EVENT)).toBe('skipped');
    });
  });

  describe('handleDelivery — ack/nack + metrics', () => {
    it('acks on success and records enqueued', async () => {
      const { consumer, metrics } = build();
      const ch = fakeChannel();
      await consumer.handleDelivery(ch as any, msg());
      expect(ch.ack).toHaveBeenCalledTimes(1);
      expect(metrics.enqueued).toHaveBeenCalledTimes(1);
    });

    it('F2: dead-letters with a CONFIRMED handoff before ack', async () => {
      const { consumer, metrics } = build();
      const ch = fakeChannel();
      await consumer.handleDelivery(ch as any, msg({ messageId: undefined }));
      expect(ch.sendToQueue).toHaveBeenCalledWith('order.created.notifications.dlq', expect.any(Buffer), expect.anything(), expect.any(Function));
      expect(ch.ack).toHaveBeenCalledTimes(1);
      expect(metrics.deadLettered).toHaveBeenCalled();
    });

    it('F2: if the DLQ confirm fails, the message is NOT acked (no loss)', async () => {
      const { consumer } = build();
      const ch = fakeChannel({ confirmFails: true });
      await consumer.handleDelivery(ch as any, msg({ messageId: undefined }));
      expect(ch.ack).not.toHaveBeenCalled();
    });

    it('F3: infra error (P1001) → requeue (no x-death) + pause, not DLQ', async () => {
      const { consumer, metrics } = build(buildPrisma({ findFail: p1001() }));
      const ch = fakeChannel();
      await consumer.handleDelivery(ch as any, msg());
      expect(ch.nack).toHaveBeenCalledWith(expect.anything(), false, true); // requeue=true
      expect(metrics.consumerPaused).toHaveBeenCalledTimes(1);
      expect(ch.sendToQueue).not.toHaveBeenCalled();
      expect(ch.ack).not.toHaveBeenCalled();
    });

    it('transient (non-infra) below cap → nack to retry', async () => {
      const { consumer, metrics } = build(buildPrisma({ txFail: new Error('deadlock') }));
      const ch = fakeChannel();
      await consumer.handleDelivery(ch as any, msg({ headers: { 'x-death': [{ count: 2 }] } }));
      expect(ch.nack).toHaveBeenCalledWith(expect.anything(), false, false);
      expect(metrics.consumerRetried).toHaveBeenCalledTimes(1);
    });

    it('poison at the cap → dead-letter', async () => {
      const { consumer } = build(buildPrisma({ txFail: new Error('deadlock') }));
      const ch = fakeChannel();
      await consumer.handleDelivery(ch as any, msg({ headers: { 'x-death': [{ count: 5 }] } }));
      expect(ch.sendToQueue).toHaveBeenCalledWith('order.created.notifications.dlq', expect.any(Buffer), expect.anything(), expect.any(Function));
      expect(ch.ack).toHaveBeenCalledTimes(1);
    });
  });

  describe('helpers + lifecycle', () => {
    it('countDeaths sums x-death', () => {
      expect(countDeaths(msg({ headers: {} }))).toBe(0);
      expect(countDeaths(msg({ headers: { 'x-death': [{ count: 2 }, { count: 3 }] } }))).toBe(5);
    });

    it('isInfraError classifies connection errors only', () => {
      expect(isInfraError(p1001())).toBe(true);
      expect(isInfraError(p2002())).toBe(false);
      expect(isInfraError(new Error('x'))).toBe(false);
    });

    it('does not start when disabled', async () => {
      const { consumer, rabbit } = build(buildPrisma(), { ...CONFIG, enabled: false });
      await consumer.onApplicationBootstrap();
      expect(rabbit.createConsumerChannel).not.toHaveBeenCalled();
    });
  });
});
