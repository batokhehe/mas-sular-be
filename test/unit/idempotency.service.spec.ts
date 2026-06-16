import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdempotencyService, SupersededError } from '../../src/infrastructure/idempotency/idempotency.service';
import { IdempotencyConfig } from '../../src/infrastructure/idempotency/idempotency.config';

const NOW = 2_000_000_000_000;

const config: IdempotencyConfig = {
  checkoutEnabled: true,
  checkoutRequired: false,
  replayMode: 'snapshot',
  retentionMs: 48 * 60 * 60 * 1000,
  reclaimMs: 120 * 1000,
  retryAfterSeconds: 2,
};

function buildPrisma() {
  return {
    idempotencyKey: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  };
}

function build() {
  const prisma = buildPrisma();
  const service = new IdempotencyService(prisma as any, config);
  (service as any).nowMs = () => NOW;
  return { service, prisma };
}

const CTX = {
  userId: 'user-1',
  key: 'key-abc',
  method: 'POST',
  endpoint: '/checkout/order',
  fingerprintInput: { body: { a: 1, items: [{ x: 1 }] } },
};

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
  });
}

describe('IdempotencyService (fencing)', () => {
  describe('computeFingerprint', () => {
    it('is stable under object key reordering', () => {
      const { service } = build();
      expect(service.computeFingerprint({ a: 1, b: 2 })).toBe(service.computeFingerprint({ b: 2, a: 1 }));
    });

    it('changes when a value changes', () => {
      const { service } = build();
      expect(service.computeFingerprint({ a: 1 })).not.toBe(service.computeFingerprint({ a: 2 }));
    });
  });

  describe('begin / reserve', () => {
    it('reserves a fresh key stamping owner + acquisition time (token defaults to 1)', async () => {
      const { service, prisma } = build();
      prisma.idempotencyKey.findUnique.mockResolvedValue(null);
      prisma.idempotencyKey.create.mockResolvedValue({ id: 'rec-1', status: 'PROCESSING', fenceToken: 1 });

      const result = await service.begin(CTX);

      expect(result).toEqual({ kind: 'proceed', record: { id: 'rec-1', status: 'PROCESSING', fenceToken: 1 } });
      const data = prisma.idempotencyKey.create.mock.calls[0][0].data;
      expect(typeof data.ownerId).toBe('string');
      expect(data.ownershipAcquiredAt).toBeInstanceOf(Date);
      expect(data.status).toBe('PROCESSING');
    });

    it('replays a COMPLETED record', async () => {
      const { service, prisma } = build();
      const fp = service.computeFingerprint(CTX.fingerprintInput);
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        id: 'rec-1',
        requestFingerprint: fp,
        status: 'COMPLETED',
        responseStatusCode: 201,
        responseBody: { id: 'order-1' },
      });

      expect(await service.begin(CTX)).toEqual({ kind: 'replay', statusCode: 201, body: { id: 'order-1' } });
      expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
    });

    it('returns processing for a fresh in-flight PROCESSING record', async () => {
      const { service, prisma } = build();
      const fp = service.computeFingerprint(CTX.fingerprintInput);
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        id: 'rec-1',
        requestFingerprint: fp,
        status: 'PROCESSING',
        fenceToken: 1,
        ownershipAcquiredAt: new Date(NOW - 1_000), // within reclaim window
        createdAt: new Date(NOW - 1_000),
      });

      expect(await service.begin(CTX)).toEqual({ kind: 'processing' });
    });

    it('throws 422 on fingerprint mismatch', async () => {
      const { service, prisma } = build();
      prisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'rec-1', requestFingerprint: 'different', status: 'COMPLETED' });
      await expect(service.begin(CTX)).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('resolves a concurrent reserve conflict to processing', async () => {
      const { service, prisma } = build();
      const fp = service.computeFingerprint(CTX.fingerprintInput);
      prisma.idempotencyKey.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'rec-1', requestFingerprint: fp, status: 'PROCESSING', fenceToken: 1, ownershipAcquiredAt: new Date(NOW) });
      prisma.idempotencyKey.create.mockRejectedValue(uniqueViolation());

      expect(await service.begin(CTX)).toEqual({ kind: 'processing' });
    });
  });

  describe('reclaim CAS', () => {
    it('re-reserves a FAILED record by compare-and-swapping the fenceToken', async () => {
      const { service, prisma } = build();
      const fp = service.computeFingerprint(CTX.fingerprintInput);
      prisma.idempotencyKey.findUnique
        .mockResolvedValueOnce({ id: 'rec-1', requestFingerprint: fp, status: 'FAILED', fenceToken: 3, createdAt: new Date(NOW), ownershipAcquiredAt: new Date(NOW) })
        .mockResolvedValueOnce({ id: 'rec-1', status: 'PROCESSING', fenceToken: 4 });
      prisma.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.begin(CTX);

      const call = prisma.idempotencyKey.updateMany.mock.calls[0][0];
      expect(call.where).toEqual(expect.objectContaining({ id: 'rec-1', fenceToken: 3, status: 'FAILED' }));
      expect(call.data).toEqual(expect.objectContaining({ fenceToken: { increment: 1 }, status: 'PROCESSING' }));
      expect(result).toEqual({ kind: 'proceed', record: { id: 'rec-1', status: 'PROCESSING', fenceToken: 4 } });
    });

    it('reclaims a stuck PROCESSING record using ownershipAcquiredAt (not createdAt)', async () => {
      const { service, prisma } = build();
      const fp = service.computeFingerprint(CTX.fingerprintInput);
      prisma.idempotencyKey.findUnique
        .mockResolvedValueOnce({ id: 'rec-1', requestFingerprint: fp, status: 'PROCESSING', fenceToken: 5, createdAt: new Date(NOW - 10_000_000), ownershipAcquiredAt: new Date(NOW - 200_000) })
        .mockResolvedValueOnce({ id: 'rec-1', status: 'PROCESSING', fenceToken: 6 });
      prisma.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.begin(CTX);

      const call = prisma.idempotencyKey.updateMany.mock.calls[0][0];
      expect(call.where).toEqual(
        expect.objectContaining({ id: 'rec-1', fenceToken: 5, status: 'PROCESSING', ownershipAcquiredAt: { lt: expect.any(Date) } }),
      );
      // claim must not touch immutable createdAt
      expect(call.data.createdAt).toBeUndefined();
      expect((result as any).record.fenceToken).toBe(6);
    });

    it('returns processing when a reclaim CAS race is lost', async () => {
      const { service, prisma } = build();
      const fp = service.computeFingerprint(CTX.fingerprintInput);
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        id: 'rec-1', requestFingerprint: fp, status: 'PROCESSING', fenceToken: 5,
        createdAt: new Date(NOW - 10_000_000), ownershipAcquiredAt: new Date(NOW - 200_000),
      });
      prisma.idempotencyKey.updateMany.mockResolvedValue({ count: 0 });

      expect(await service.begin(CTX)).toEqual({ kind: 'processing' });
    });
  });

  describe('finalize CAS', () => {
    it('completes the row when the fenceToken still matches', async () => {
      const { service } = build();
      const tx = { idempotencyKey: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };

      await service.finalize(tx as any, 'rec-1', 5, { statusCode: 201, body: { id: 'order-1' }, resourceType: 'Order', resourceId: 'order-1' });

      expect(tx.idempotencyKey.updateMany).toHaveBeenCalledWith({
        where: { id: 'rec-1', fenceToken: 5, status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'COMPLETED', responseStatusCode: 201, resourceId: 'order-1' }),
      });
    });

    it('throws SupersededError when the fenceToken no longer matches (count 0)', async () => {
      const { service } = build();
      const tx = { idempotencyKey: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };

      await expect(
        service.finalize(tx as any, 'rec-1', 5, { statusCode: 201, body: {} }),
      ).rejects.toBeInstanceOf(SupersededError);
    });
  });

  describe('markFailed CAS', () => {
    it('flips to FAILED only when still owned (fenceToken + PROCESSING)', async () => {
      const { service, prisma } = build();
      prisma.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });

      await service.markFailed('rec-1', 5, new Error('boom'));

      expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledWith({
        where: { id: 'rec-1', fenceToken: 5, status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'FAILED', lastError: 'boom' }),
      });
    });

    it('is a no-op (count 0) when superseded and swallows DB errors', async () => {
      const { service, prisma } = build();
      prisma.idempotencyKey.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.markFailed('rec-1', 5, new Error('boom'))).resolves.toBeUndefined();

      prisma.idempotencyKey.updateMany.mockRejectedValue(new Error('db down'));
      await expect(service.markFailed('rec-1', 5, new Error('boom'))).resolves.toBeUndefined();
    });
  });

  describe('resolveAfterSupersession', () => {
    it('replays when the winner has COMPLETED', async () => {
      const { service, prisma } = build();
      prisma.idempotencyKey.findUnique.mockResolvedValue({ status: 'COMPLETED', responseStatusCode: 201, responseBody: { id: 'order-1' } });
      expect(await service.resolveAfterSupersession('user-1', 'key-abc')).toEqual({ kind: 'replay', statusCode: 201, body: { id: 'order-1' } });
    });

    it('returns processing when the winner is still in flight', async () => {
      const { service, prisma } = build();
      prisma.idempotencyKey.findUnique.mockResolvedValue({ status: 'PROCESSING' });
      expect(await service.resolveAfterSupersession('user-1', 'key-abc')).toEqual({ kind: 'processing' });
    });
  });
});
