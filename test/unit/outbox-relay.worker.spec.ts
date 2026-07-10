import { OutboxRelayWorker } from '../../src/infrastructure/outbox/outbox-relay.worker';
import { OutboxRelayConfig } from '../../src/infrastructure/outbox/outbox.config';

function buildConfig(overrides: Partial<OutboxRelayConfig> = {}): OutboxRelayConfig {
  return {
    enabled: true,
    rabbitmqUrl: 'amqp://localhost',
    pollIntervalMs: 1000,
    batchSize: 50,
    leaseMs: 30_000,
    backoffBaseMs: 1_000,
    backoffCapMs: 100_000,
    healthLogIntervalMs: 60_000,
    ...overrides,
  };
}

function buildPrisma() {
  return {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    outboxEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }), // fenced write-back (C1)
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}

function buildRabbit() {
  return { publishWithConfirm: jest.fn().mockResolvedValue(undefined) };
}

function buildMetrics() {
  return { publishedOk: jest.fn(), retried: jest.fn(), failedTerminal: jest.fn(), health: jest.fn() };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    aggregateType: 'payment',
    aggregateId: 'pay-1',
    eventName: 'payment.paid',
    eventVersion: 1,
    exchange: 'payments',
    routingKey: 'payment.paid',
    payload: { paymentId: 'pay-1', amount: 50000 },
    metadata: { source: 'admin.verifyPayment' },
    status: 'PENDING',
    attempts: 0,
    maxAttempts: 10,
    nextAttemptAt: new Date(0),
    lockedUntil: null,
    lockedBy: 'relay#claim-1',
    lastError: null,
    occurredAt: new Date('2026-06-11T00:00:00.000Z'),
    createdAt: new Date('2026-06-11T00:00:00.000Z'),
    publishedAt: null,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function build(config = buildConfig(), prisma = buildPrisma(), rabbit = buildRabbit(), metrics = buildMetrics()) {
  const worker = new OutboxRelayWorker(prisma as any, rabbit as any, metrics as any, config);
  // deterministic seams
  (worker as any).nowMs = () => 1_000_000;
  (worker as any).randomFn = () => 0.5;
  return { worker, prisma, rabbit, config, metrics };
}

describe('OutboxRelayWorker', () => {
  describe('claim', () => {
    it('lease-stamps then reads its own claim, honoring batch size', async () => {
      const { worker, prisma } = build(buildConfig({ batchSize: 50 }));
      prisma.outboxEvent.findMany.mockResolvedValue([row()]);

      await worker.processBatch();

      expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      const sql = prisma.$executeRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain('UPDATE `OutboxEvent`');
      expect(sql).toContain("`status` = 'PENDING'");
      expect(sql).toContain('LIMIT 50');
      expect(prisma.outboxEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'PENDING' }),
          orderBy: { createdAt: 'asc' },
        }),
      );
      // claim token passed to UPDATE matches the one used to read back the rows
      const claimToken = prisma.$executeRawUnsafe.mock.calls[0][2] as string;
      expect(prisma.outboxEvent.findMany.mock.calls[0][0].where.lockedBy).toBe(claimToken);
    });
  });

  describe('publish (success)', () => {
    it('publishes with confirm options and marks the row PUBLISHED', async () => {
      const { worker, prisma, rabbit } = build();
      prisma.outboxEvent.findMany.mockResolvedValue([row()]);

      const claimed = await worker.processBatch();

      expect(claimed).toBe(1);
      expect(rabbit.publishWithConfirm).toHaveBeenCalledWith(
        'payments',
        'payment.paid',
        expect.any(Buffer),
        expect.objectContaining({ messageId: 'evt-1', persistent: true, contentType: 'application/json', type: 'payment.paid' }),
      );
      expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt-1', lockedBy: 'relay#claim-1' }, // fenced on the claim (C1)
        data: expect.objectContaining({ status: 'PUBLISHED', lockedBy: null, lockedUntil: null }),
      });
    });

    it('publishes a batch in createdAt order', async () => {
      const { worker, prisma, rabbit } = build();
      prisma.outboxEvent.findMany.mockResolvedValue([
        row({ id: 'A', createdAt: new Date('2026-06-11T00:00:00Z') }),
        row({ id: 'B', createdAt: new Date('2026-06-11T00:00:01Z') }),
      ]);

      await worker.processBatch();

      expect(rabbit.publishWithConfirm.mock.calls[0][3].messageId).toBe('A');
      expect(rabbit.publishWithConfirm.mock.calls[1][3].messageId).toBe('B');
    });
  });

  describe('publish (failure → retry)', () => {
    it('increments attempts and backs off without marking PUBLISHED or FAILED', async () => {
      const { worker, prisma, rabbit } = build();
      rabbit.publishWithConfirm.mockRejectedValue(new Error('broker down'));
      prisma.outboxEvent.findMany.mockResolvedValue([row({ attempts: 0, maxAttempts: 10 })]);

      await worker.processBatch();

      const data = prisma.outboxEvent.updateMany.mock.calls[0][0].data;
      expect(data.attempts).toBe(1);
      expect(data.status).toBeUndefined(); // stays PENDING
      expect(data.lastError).toBe('broker down');
      expect(data.lockedBy).toBeNull();
      // full-jitter backoff: base 1000 * 2^0 * random(0.5) = 500ms from nowMs 1_000_000
      expect((data.nextAttemptAt as Date).getTime()).toBe(1_000_500);
    });

    it('marks the row FAILED once attempts reach maxAttempts', async () => {
      const { worker, prisma, rabbit } = build();
      rabbit.publishWithConfirm.mockRejectedValue(new Error('still down'));
      prisma.outboxEvent.findMany.mockResolvedValue([row({ attempts: 9, maxAttempts: 10 })]);

      await worker.processBatch();

      expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt-1', lockedBy: 'relay#claim-1' },
        data: expect.objectContaining({ status: 'FAILED', attempts: 10, lastError: 'still down' }),
      });
    });

    it('caps the backoff delay', async () => {
      const { worker, prisma, rabbit } = build(buildConfig({ backoffBaseMs: 1000, backoffCapMs: 100_000 }));
      rabbit.publishWithConfirm.mockRejectedValue(new Error('down'));
      // attempts 10 -> exp = 1000 * 2^9 = 512000 > cap 100000 -> capped 100000 * 0.5 = 50000
      prisma.outboxEvent.findMany.mockResolvedValue([row({ attempts: 9, maxAttempts: 100 })]);

      await worker.processBatch();

      const data = prisma.outboxEvent.updateMany.mock.calls[0][0].data;
      expect((data.nextAttemptAt as Date).getTime()).toBe(1_050_000);
    });
  });

  describe('at-least-once semantics', () => {
    it('leaves a confirmed-but-unmarked row claimable (re-published next tick)', async () => {
      const { worker, prisma, rabbit } = build();
      prisma.outboxEvent.findMany.mockResolvedValue([row()]);
      rabbit.publishWithConfirm.mockResolvedValue(undefined); // broker CONFIRMED
      // ...but the PUBLISHED mark fails; the retry update then succeeds
      prisma.outboxEvent.updateMany
        .mockRejectedValueOnce(new Error('db hiccup'))
        .mockResolvedValueOnce({ count: 1 });

      await worker.processBatch();

      // first update attempted PUBLISHED, failed; second update reschedules (attempts=1)
      expect(prisma.outboxEvent.updateMany).toHaveBeenCalledTimes(2);
      const retry = prisma.outboxEvent.updateMany.mock.calls[1][0].data;
      expect(retry.attempts).toBe(1);
      expect(retry.status).toBeUndefined(); // still PENDING -> will be re-published
    });
  });

  describe('health logging', () => {
    it('logs pending_count, failed_count and oldest_pending_age', async () => {
      const { worker, prisma } = build();
      prisma.outboxEvent.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
      prisma.outboxEvent.findFirst.mockResolvedValue({ createdAt: new Date(1_000_000 - 5_000) });
      const logSpy = jest.spyOn((worker as any).logger, 'log').mockImplementation(() => undefined);

      await (worker as any).maybeLogHealth();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('pending_count=3 failed_count=1 oldest_pending_age_ms=5000'),
      );
    });

    it('throttles health logging to healthLogIntervalMs', async () => {
      const { worker } = build(buildConfig({ healthLogIntervalMs: 60_000 }));
      const logSpy = jest.spyOn((worker as any).logger, 'log').mockImplementation(() => undefined);

      await (worker as any).maybeLogHealth();
      await (worker as any).maybeLogHealth(); // same nowMs, within interval

      expect(logSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('lifecycle gating', () => {
    it('does not start when disabled', () => {
      const { worker, prisma } = build(buildConfig({ enabled: false }));
      worker.onApplicationBootstrap();
      expect((worker as any).timer).toBeNull();
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('stays idle when enabled without a broker URL', () => {
      const { worker } = build(buildConfig({ enabled: true, rabbitmqUrl: undefined }));
      worker.onApplicationBootstrap();
      expect((worker as any).timer).toBeNull();
    });
  });
});

// --- Regression: C1 — fenced write-back. ---
describe('lease fencing (C1)', () => {
  it('a stale relay that lost its lease gives up silently (row stays with the new owner)', async () => {
    const { worker, prisma, rabbit } = build();
    prisma.outboxEvent.findMany.mockResolvedValue([row()]);
    rabbit.publishWithConfirm.mockResolvedValue(undefined); // broker confirmed
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 0 }); // lease reclaimed

    await expect(worker.processBatch()).resolves.not.toThrow();

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'evt-1', lockedBy: 'relay#claim-1' } }),
    );
    // markPublished lost → fenced scheduleRetry is NOT attempted as an overwrite;
    // exactly one fenced write-back ran.
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledTimes(1);
  });
});
