import { RetentionWorker } from '../../src/infrastructure/lifecycle/retention.worker';
import { LifecycleConfig, loadLifecycleConfig } from '../../src/infrastructure/lifecycle/lifecycle.config';

const NOW = 1_000_000_000_000;

function cfg(over: Partial<LifecycleConfig> = {}): LifecycleConfig {
  return {
    enabled: true,
    dryRun: false,
    batchSize: 1000,
    intervalMs: 86_400_000,
    initialDelayMs: 60_000,
    maxBatchesPerPolicy: 1000,
    outboxPublishedDays: 7,
    outboxFailedDays: 90,
    processedDays: 30,
    notificationSentDays: 30,
    notificationFailedDays: 90,
    uploadTokenExpiredDays: 14,
    ...over,
  };
}

function build(config = cfg()) {
  const prisma = { $executeRawUnsafe: jest.fn().mockResolvedValue(0), $queryRawUnsafe: jest.fn().mockResolvedValue([{ c: 0 }]) };
  const metrics = { swept: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const worker = new RetentionWorker(prisma as any, metrics as any, config);
  (worker as any).nowMs = () => NOW;
  return { worker, prisma, metrics };
}

const DAY = 24 * 60 * 60 * 1000;

describe('RetentionWorker', () => {
  describe('policies (predicates + windows)', () => {
    it('targets exactly the terminal/expired slices, lease-safe', () => {
      const { worker } = build();
      const byName = Object.fromEntries(worker.policies().map((p) => [p.name, p]));

      expect(byName['OutboxEvent.PUBLISHED'].table).toBe('`OutboxEvent`');
      expect(byName['OutboxEvent.PUBLISHED'].where).toBe("`status` = 'PUBLISHED' AND `lockedUntil` IS NULL AND `createdAt` < ?");
      expect(byName['OutboxEvent.PUBLISHED'].cutoff.getTime()).toBe(NOW - 7 * DAY);

      expect(byName['OutboxEvent.FAILED'].where).toBe("`status` = 'FAILED' AND `lockedUntil` IS NULL AND `createdAt` < ?");
      expect(byName['OutboxEvent.FAILED'].cutoff.getTime()).toBe(NOW - 90 * DAY);

      expect(byName['ProcessedEvent'].where).toBe('`processedAt` < ?');
      expect(byName['ProcessedEvent'].cutoff.getTime()).toBe(NOW - 30 * DAY);

      expect(byName['NotificationOutbox.SENT'].where).toBe("`status` = 'SENT' AND `lockedUntil` IS NULL AND `sentAt` < ?");
      expect(byName['NotificationOutbox.SENT'].cutoff.getTime()).toBe(NOW - 30 * DAY);

      expect(byName['NotificationOutbox.FAILED'].where).toBe("`status` = 'FAILED' AND `lockedUntil` IS NULL AND `createdAt` < ?");

      expect(byName['IdempotencyKey'].where).toBe('`expiresAt` < ?');
      expect(byName['IdempotencyKey'].cutoff.getTime()).toBe(NOW); // expiresAt < now

      // PaymentUploadToken: expiresAt < now - 14d, so active/recently-expired tokens are safe.
      expect(byName['PaymentUploadToken'].table).toBe('`PaymentUploadToken`');
      expect(byName['PaymentUploadToken'].where).toBe('`expiresAt` < ?');
      expect(byName['PaymentUploadToken'].cutoff.getTime()).toBe(NOW - 14 * DAY);
    });

    it('PaymentUploadToken cutoff is 14 days in the past → never deletes active or future-expiry tokens', () => {
      const { worker } = build();
      const token = worker.policies().find((p) => p.name === 'PaymentUploadToken')!;
      // A token expiring in the future, or within the last 14 days, is NOT < cutoff.
      expect(token.cutoff.getTime()).toBeLessThan(NOW);
      expect(NOW + 60_000).toBeGreaterThan(token.cutoff.getTime()); // future expiry not matched
      expect(NOW - 5 * DAY).toBeGreaterThan(token.cutoff.getTime()); // 5-day-expired not matched
      expect(NOW - 20 * DAY).toBeLessThan(token.cutoff.getTime()); // 20-day-expired IS matched
    });

    it('never targets PENDING / SENT-success sweep never touches FAILED', () => {
      const { worker } = build();
      const wheres = worker.policies().map((p) => p.where).join(' | ');
      expect(wheres).not.toContain("'PENDING'");
      // the success sweeps are status-pinned, so they cannot match FAILED/PENDING
      const sent = worker.policies().find((p) => p.name === 'NotificationOutbox.SENT')!;
      expect(sent.where).toContain("'SENT'");
      expect(sent.where).not.toContain("'FAILED'");
    });
  });

  describe('delete (real mode) + batching', () => {
    it('issues a batched DELETE with the cutoff bound, looping until a short batch', async () => {
      const { worker, prisma } = build(cfg({ batchSize: 1000 }));
      const sent = worker.policies().find((p) => p.name === 'NotificationOutbox.SENT')!;
      prisma.$executeRawUnsafe.mockResolvedValueOnce(1000).mockResolvedValueOnce(7); // full, then short

      const result = await worker.sweepPolicy(sent);

      expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
      const sql = prisma.$executeRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain('DELETE FROM `NotificationOutbox`');
      expect(sql).toContain('LIMIT 1000');
      expect(prisma.$executeRawUnsafe.mock.calls[0][1]).toBe(sent.cutoff); // parameterized cutoff
      expect(result.deletedCount).toBe(1007);
    });

    it('stops at maxBatchesPerPolicy (no unbounded loop)', async () => {
      const { worker, prisma } = build(cfg({ batchSize: 10, maxBatchesPerPolicy: 3 }));
      prisma.$executeRawUnsafe.mockResolvedValue(10); // always a full batch
      const result = await worker.sweepPolicy(worker.policies()[0]);
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(3);
      expect(result.deletedCount).toBe(30);
    });

    it('runOnce sweeps all seven policies', async () => {
      const { worker, prisma } = build();
      await worker.runOnce();
      // 7 policies, each one DELETE (returns 0 → single batch)
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(7);
    });

    it('batches the PaymentUploadToken sweep with the 14-day cutoff bound', async () => {
      const { worker, prisma } = build(cfg({ batchSize: 1000 }));
      const token = worker.policies().find((p) => p.name === 'PaymentUploadToken')!;
      prisma.$executeRawUnsafe.mockResolvedValueOnce(1000).mockResolvedValueOnce(3); // full, then short

      const result = await worker.sweepPolicy(token);

      expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
      const sql = prisma.$executeRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain('DELETE FROM `PaymentUploadToken`');
      expect(sql).toContain('LIMIT 1000');
      expect(prisma.$executeRawUnsafe.mock.calls[0][1]).toBe(token.cutoff); // parameterized cutoff
      expect(result.deletedCount).toBe(1003);
    });
  });

  describe('dry-run', () => {
    it('counts would-delete and performs NO deletes', async () => {
      const { worker, prisma, metrics } = build(cfg({ dryRun: true }));
      prisma.$queryRawUnsafe.mockResolvedValue([{ c: 42 }]);

      const result = await worker.sweepPolicy(worker.policies()[0]);

      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain('SELECT COUNT(*)');
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
      expect(result.wouldDeleteCount).toBe(42);
      expect(result.deletedCount).toBe(0);
      expect(metrics.swept).toHaveBeenCalledWith(expect.objectContaining({ wouldDeleteCount: 42, deletedCount: 0, dryRun: true }));
    });

    it('dry-run counts PaymentUploadToken without deleting', async () => {
      const { worker, prisma, metrics } = build(cfg({ dryRun: true }));
      const token = worker.policies().find((p) => p.name === 'PaymentUploadToken')!;
      prisma.$queryRawUnsafe.mockResolvedValue([{ c: 9 }]);

      const result = await worker.sweepPolicy(token);

      expect(prisma.$queryRawUnsafe.mock.calls[0][0]).toContain('SELECT COUNT(*) AS c FROM `PaymentUploadToken`');
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
      expect(result.wouldDeleteCount).toBe(9);
      expect(metrics.swept).toHaveBeenCalledWith(expect.objectContaining({ table: 'PaymentUploadToken', dryRun: true }));
    });
  });

  describe('metrics', () => {
    it('emits table/deleted/duration on a real sweep', async () => {
      const { worker, prisma, metrics } = build();
      prisma.$executeRawUnsafe.mockResolvedValue(0);
      await worker.sweepPolicy(worker.policies()[2]); // ProcessedEvent
      expect(metrics.swept).toHaveBeenCalledWith(
        expect.objectContaining({ table: 'ProcessedEvent', deletedCount: 0, dryRun: false, durationMs: expect.any(Number) }),
      );
    });
  });

  describe('lifecycle gating', () => {
    it('does not schedule when disabled', () => {
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

describe('loadLifecycleConfig', () => {
  it('defaults disabled with approved windows', () => {
    const c = loadLifecycleConfig({});
    expect(c.enabled).toBe(false);
    expect(c.dryRun).toBe(false);
    expect(c.batchSize).toBe(1000);
    expect(c.outboxPublishedDays).toBe(7);
    expect(c.processedDays).toBe(30);
    expect(c.notificationSentDays).toBe(30);
    expect(c.outboxFailedDays).toBe(90);
    expect(c.notificationFailedDays).toBe(90);
    expect(c.uploadTokenExpiredDays).toBe(14);
  });

  it('parses overrides', () => {
    const c = loadLifecycleConfig({
      RETENTION_ENABLED: 'true',
      RETENTION_DRY_RUN: 'true',
      RETENTION_PROCESSED_DAYS: '14',
      RETENTION_UPLOAD_TOKEN_DAYS: '30',
    });
    expect(c.enabled).toBe(true);
    expect(c.dryRun).toBe(true);
    expect(c.processedDays).toBe(14);
    expect(c.uploadTokenExpiredDays).toBe(30);
  });
});
