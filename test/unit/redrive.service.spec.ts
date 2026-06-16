import { RedriveService } from '../../src/infrastructure/lifecycle/redrive.service';

function buildPrisma() {
  return {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ c: 0 }]),
  };
}

function buildChannel(opts: { messages?: number; publishFails?: boolean } = {}) {
  const n = opts.messages ?? 0;
  let delivered = 0;
  const channel = {
    get: jest.fn().mockImplementation(async () => {
      if (delivered >= n) return false;
      delivered += 1;
      return { content: Buffer.from('{}'), properties: { messageId: `m${delivered}`, headers: {} } };
    }),
    publish: jest.fn((_e: string, _r: string, _c: Buffer, _p: unknown, cb: (e: unknown) => void) =>
      cb(opts.publishFails ? new Error('nack') : null),
    ),
    ack: jest.fn(),
    nack: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return channel;
}

function build(channel = buildChannel()) {
  const prisma = buildPrisma();
  const rabbit = { createConsumerChannel: jest.fn().mockResolvedValue(channel) };
  const metrics = { redrive: jest.fn(), dlqRedrive: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new RedriveService(prisma as any, rabbit as any, metrics as any);
  return { service, prisma, rabbit, channel, metrics };
}

describe('RedriveService', () => {
  describe('A. OutboxEvent FAILED redrive', () => {
    it('resets FAILED→PENDING with the documented fields and applies filters', async () => {
      const { service, prisma } = build();
      prisma.$executeRawUnsafe.mockResolvedValueOnce(3);

      const result = await service.redriveFailedOutboxEvents({ eventName: 'payment.paid', createdAfter: new Date(0) });

      const [sql, ...params] = prisma.$executeRawUnsafe.mock.calls[0];
      expect(sql).toContain("`status` = 'PENDING'");
      expect(sql).toContain('`attempts` = 0');
      expect(sql).toContain('`lockedUntil` = NULL');
      expect(sql).toContain('`lastError` = NULL');
      expect(sql).toContain("WHERE `status` = 'FAILED'"); // safety: only FAILED
      expect(sql).toContain('`eventName` = ?');
      expect(sql).toContain('`createdAt` >= ?');
      expect(params[0]).toBeInstanceOf(Date); // nextAttemptAt = now
      expect(params).toContain('payment.paid');
      expect(result).toEqual({ matched: 0, redriven: 3, dryRun: false });
    });

    it('dry-run counts and performs no UPDATE', async () => {
      const { service, prisma } = build();
      prisma.$queryRawUnsafe.mockResolvedValue([{ c: 9 }]);
      const result = await service.redriveFailedOutboxEvents({ id: 'evt-1', dryRun: true });
      const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain('SELECT COUNT(*)');
      expect(sql).toContain("`status` = 'FAILED'");
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
      expect(result).toEqual({ matched: 9, redriven: 0, dryRun: true });
    });

    it('batches until a short batch and caps at maxBatches', async () => {
      const { service, prisma } = build();
      prisma.$executeRawUnsafe.mockResolvedValueOnce(1000).mockResolvedValueOnce(4);
      const result = await service.redriveFailedOutboxEvents({ batchSize: 1000 });
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
      expect(result.redriven).toBe(1004);
    });
  });

  describe('B. NotificationOutbox FAILED redrive', () => {
    it('applies template/channel filters on FAILED rows only', async () => {
      const { service, prisma } = build();
      await service.redriveFailedNotifications({ template: 'order.received', channel: 'EMAIL' });
      const sql = prisma.$executeRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain('UPDATE `NotificationOutbox`');
      expect(sql).toContain("WHERE `status` = 'FAILED'");
      expect(sql).toContain('`template` = ?');
      expect(sql).toContain('`channel` = ?');
    });
  });

  describe('C. Consumer DLQ shovel', () => {
    it('republishes to the source exchange/routing key, confirmed, then acks; capped by limit', async () => {
      const { service, channel } = build(buildChannel({ messages: 5 }));

      const result = await service.redriveConsumerDlq({ limit: 3 });

      expect(channel.get).toHaveBeenCalledTimes(3); // capped
      expect(channel.publish).toHaveBeenCalledTimes(3);
      expect(channel.publish.mock.calls[0][0]).toBe('orders'); // exchange
      expect(channel.publish.mock.calls[0][1]).toBe('order.created'); // routing key
      expect(channel.ack).toHaveBeenCalledTimes(3);
      expect(channel.close).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ inspected: 3, redriven: 3, dryRun: false });
    });

    it('stops when the DLQ drains before the limit', async () => {
      const { service, channel } = build(buildChannel({ messages: 2 }));
      const result = await service.redriveConsumerDlq({ limit: 10 });
      expect(result).toEqual({ inspected: 2, redriven: 2, dryRun: false });
    });

    it('dry-run inspects and requeues without republishing or acking', async () => {
      const { service, channel } = build(buildChannel({ messages: 2 }));
      const result = await service.redriveConsumerDlq({ limit: 10, dryRun: true });
      expect(channel.nack).toHaveBeenCalledTimes(2);
      expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true); // requeue
      expect(channel.publish).not.toHaveBeenCalled();
      expect(channel.ack).not.toHaveBeenCalled();
      expect(result).toEqual({ inspected: 2, redriven: 0, dryRun: true });
    });

    it('leaves the message unacked if the republish confirm fails (no loss)', async () => {
      const { service, channel } = build(buildChannel({ messages: 1, publishFails: true }));
      await expect(service.redriveConsumerDlq({ limit: 1 })).rejects.toThrow('nack');
      expect(channel.ack).not.toHaveBeenCalled();
      expect(channel.close).toHaveBeenCalledTimes(1); // channel still closed (finally)
    });
  });
});
