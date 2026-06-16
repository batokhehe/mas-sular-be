import { NotificationSenderWorker } from '../../src/infrastructure/notifications/notification-sender.worker';
import { NotificationSenderConfig } from '../../src/infrastructure/notifications/notification.config';
import { PermanentSendError, TransientSendError } from '../../src/infrastructure/notifications/notification-provider';

const NOW = 1_000_000;

function cfg(over: Partial<NotificationSenderConfig> = {}): NotificationSenderConfig {
  return {
    enabled: true,
    batchSize: 50,
    leaseMs: 30_000,
    pollIntervalMs: 1_000,
    backoffBaseMs: 1_000,
    backoffCapMs: 100_000,
    maxAttempts: 8,
    healthLogIntervalMs: 60_000,
    breakerThreshold: 2,
    pauseMs: 30_000,
    emailApiKey: 'rk_test',
    emailFrom: 'orders@masular.test',
    emailRequestTimeoutMs: 10_000,
    ...over,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    channel: 'EMAIL',
    recipient: 'a@b.com',
    template: 'order.received',
    payload: { orderNumber: 'BN-1', customerName: 'Jane', totalPrice: 30000 },
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date(0),
    lockedUntil: null,
    lockedBy: null,
    providerMessageId: null,
    lastError: null,
    sourceMessageId: 'evt-1',
    createdAt: new Date(0),
    sentAt: null,
    ...over,
  };
}

function buildMetrics() {
  return {
    claimed: jest.fn(), sent: jest.fn(), retried: jest.fn(), failedPermanent: jest.fn(),
    failedExhausted: jest.fn(), senderPaused: jest.fn(), senderResumed: jest.fn(), health: jest.fn(),
  };
}

function build(config = cfg(), rows: ReturnType<typeof row>[] = [row()]) {
  const prisma = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    notificationOutbox: {
      findMany: jest.fn().mockResolvedValue(rows),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const email = { channel: 'EMAIL', send: jest.fn().mockResolvedValue({ providerMessageId: 'pm-1' }) };
  const renderer = { render: jest.fn().mockReturnValue({ subject: 'S', body: 'B' }) };
  const metrics = buildMetrics();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const worker = new NotificationSenderWorker(prisma as any, email as any, renderer as any, metrics as any, config);
  (worker as any).nowMs = () => NOW;
  (worker as any).randomFn = () => 0.5;
  return { worker, prisma, email, renderer, metrics };
}

describe('NotificationSenderWorker', () => {
  describe('claim', () => {
    it('lease-stamps PENDING/due/lease-free rows and reads its own claim', async () => {
      const { worker, prisma } = build(cfg({ batchSize: 50 }));
      await worker.processBatch();
      const sql = prisma.$executeRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain('UPDATE `NotificationOutbox`');
      expect(sql).toContain("`status` = 'PENDING'");
      expect(sql).toContain('`lockedUntil` IS NULL OR `lockedUntil` < ?'); // lease recovery predicate
      expect(sql).toContain('LIMIT 50');
      const token = prisma.$executeRawUnsafe.mock.calls[0][2] as string;
      expect(prisma.notificationOutbox.findMany.mock.calls[0][0].where.lockedBy).toBe(token);
    });
  });

  describe('send', () => {
    it('sends with the row id as the provider idempotency key and marks SENT', async () => {
      const { worker, prisma, email, metrics } = build();
      await worker.processBatch();
      expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'n1', recipient: 'a@b.com' }));
      expect(prisma.notificationOutbox.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: expect.objectContaining({ status: 'SENT', providerMessageId: 'pm-1', lockedUntil: null, lockedBy: null }),
      });
      expect(metrics.sent).toHaveBeenCalledTimes(1);
      expect(metrics.claimed).toHaveBeenCalledWith(1);
    });
  });

  describe('retry & terminal', () => {
    it('transient → backoff retry (attempts++/nextAttemptAt), stays PENDING', async () => {
      const { worker, prisma, email, metrics } = build();
      email.send.mockRejectedValue(new TransientSendError('5xx'));
      await worker.sendRow(row({ attempts: 0 }) as any);
      const data = prisma.notificationOutbox.update.mock.calls[0][0].data;
      expect(data.attempts).toBe(1);
      expect(data.status).toBeUndefined();
      expect((data.nextAttemptAt as Date).getTime()).toBe(NOW + 500); // base 1000 * 2^0 * 0.5
      expect(metrics.retried).toHaveBeenCalledTimes(1);
    });

    it('honors a provider Retry-After over the computed backoff', async () => {
      const { worker, prisma, email } = build();
      email.send.mockRejectedValue(new TransientSendError('rate limited', 7_000));
      await worker.sendRow(row({ attempts: 0 }) as any);
      const data = prisma.notificationOutbox.update.mock.calls[0][0].data;
      expect((data.nextAttemptAt as Date).getTime()).toBe(NOW + 7_000); // Retry-After, not the 500ms backoff
    });

    it('permanent → terminal FAILED', async () => {
      const { worker, prisma, email, metrics } = build();
      email.send.mockRejectedValue(new PermanentSendError('bad recipient'));
      await worker.sendRow(row() as any);
      expect(prisma.notificationOutbox.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: expect.objectContaining({ status: 'FAILED' }),
      });
      expect(metrics.failedPermanent).toHaveBeenCalledTimes(1);
    });

    it('transient at the attempt cap → FAILED (exhausted)', async () => {
      const { worker, prisma, email, metrics } = build(cfg({ maxAttempts: 8 }));
      email.send.mockRejectedValue(new TransientSendError('down'));
      await worker.sendRow(row({ attempts: 7 }) as any);
      expect(prisma.notificationOutbox.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: expect.objectContaining({ status: 'FAILED', attempts: 8 }),
      });
      expect(metrics.failedExhausted).toHaveBeenCalledTimes(1);
    });

    it('unknown channel → permanent FAILED (no provider)', async () => {
      const { worker, prisma, metrics } = build();
      await worker.sendRow(row({ channel: 'SMS' }) as any);
      expect(prisma.notificationOutbox.update).toHaveBeenCalledWith({ where: { id: 'n1' }, data: expect.objectContaining({ status: 'FAILED' }) });
      expect(metrics.failedPermanent).toHaveBeenCalledTimes(1);
    });
  });

  describe('circuit breaker (pause/resume)', () => {
    it('trips after breakerThreshold transient failures, then resumes on success', async () => {
      const { worker, email, metrics } = build(cfg({ breakerThreshold: 2 }));
      email.send.mockRejectedValue(new TransientSendError('down'));
      await worker.sendRow(row() as any);
      await worker.sendRow(row() as any);
      expect(metrics.senderPaused).toHaveBeenCalledTimes(1);

      email.send.mockResolvedValue({ providerMessageId: 'pm-9' });
      await worker.sendRow(row() as any);
      expect(metrics.senderResumed).toHaveBeenCalledTimes(1);
    });
  });

  describe('health (F5) & lifecycle', () => {
    it('logs pending/failed/oldest-pending health', async () => {
      const { worker, prisma, metrics } = build();
      prisma.notificationOutbox.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
      prisma.notificationOutbox.findFirst.mockResolvedValue({ createdAt: new Date(NOW - 5000) });
      await (worker as any).maybeLogHealth();
      expect(metrics.health).toHaveBeenCalledWith('sender', { pending: 3, failed: 1, oldestPendingAgeMs: 5000 });
    });

    it('does not start when disabled', () => {
      const { worker, prisma } = build(cfg({ enabled: false }));
      worker.onApplicationBootstrap();
      expect((worker as any).timer).toBeNull();
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('shutdown is graceful', async () => {
      const { worker } = build();
      await expect(worker.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
