import { PaymentUploadTokenService, UPLOAD_TOKEN_TTL_MS } from '../../src/modules/payments/payment-upload-token.service';

const NOW = 1_000_000_000;

function svc(prisma: unknown = {}) {
  const s = new PaymentUploadTokenService(prisma as any);
  (s as any).nowMs = () => NOW;
  return s;
}

describe('PaymentUploadTokenService', () => {
  describe('issue', () => {
    it('stores only the hash, returns the raw 256-bit secret + URL, and expires in 72h', async () => {
      const tx = { paymentUploadToken: { create: jest.fn().mockResolvedValue({}) } };
      const s = svc();

      const issued = await s.issue(tx as any, 'pay-1');
      const stored = tx.paymentUploadToken.create.mock.calls[0][0].data;

      expect(issued.rawToken).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
      expect(stored.paymentId).toBe('pay-1');
      expect(stored.token).toBe(s.hash(issued.rawToken)); // hash persisted
      expect(stored.token).not.toBe(issued.rawToken); // raw secret never persisted
      expect(stored.expiresAt.getTime()).toBe(NOW + UPLOAD_TOKEN_TTL_MS);
      expect(UPLOAD_TOKEN_TTL_MS).toBe(72 * 60 * 60 * 1000);
      expect(issued.uploadUrl.endsWith(`/payments/upload/${issued.rawToken}`)).toBe(true);
    });
  });

  describe('resolveActive', () => {
    function withRow(row: unknown) {
      return svc({ paymentUploadToken: { findUnique: jest.fn().mockResolvedValue(row) } });
    }

    it('returns the row for an unused, unexpired token', async () => {
      const row = { id: 't1', paymentId: 'pay-1', usedAt: null, expiresAt: new Date(NOW + 1000) };
      expect(await withRow(row).resolveActive('raw')).toBe(row);
    });

    it('returns null for a used token (single-use)', async () => {
      const row = { id: 't1', paymentId: 'pay-1', usedAt: new Date(NOW - 1), expiresAt: new Date(NOW + 1000) };
      expect(await withRow(row).resolveActive('raw')).toBeNull();
    });

    it('returns null for an expired token', async () => {
      const row = { id: 't1', paymentId: 'pay-1', usedAt: null, expiresAt: new Date(NOW - 1) };
      expect(await withRow(row).resolveActive('raw')).toBeNull();
    });

    it('returns null for an unknown token (no enumeration signal)', async () => {
      expect(await withRow(null).resolveActive('raw')).toBeNull();
    });
  });

  describe('consume (single-use CAS)', () => {
    function buildTx(row: unknown, flipCount: number) {
      return {
        paymentUploadToken: {
          findUnique: jest.fn().mockResolvedValue(row),
          updateMany: jest.fn().mockResolvedValue({ count: flipCount }),
        },
      };
    }

    it('marks an active token used exactly once and returns its paymentId', async () => {
      const tx = buildTx({ id: 't1', paymentId: 'pay-1' }, 1);
      const result = await svc().consume(tx as any, 'raw');
      expect(result).toEqual({ consumed: true, paymentId: 'pay-1' });
      expect(tx.paymentUploadToken.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', usedAt: null, expiresAt: { gt: expect.any(Date) } },
        data: { usedAt: expect.any(Date) },
      });
    });

    it('replay: a second consume (CAS count 0) does not consume', async () => {
      const tx = buildTx({ id: 't1', paymentId: 'pay-1' }, 0);
      expect(await svc().consume(tx as any, 'raw')).toEqual({ consumed: false, paymentId: 'pay-1' });
    });

    it('unknown token → not consumed, no update attempted', async () => {
      const tx = buildTx(null, 0);
      expect(await svc().consume(tx as any, 'raw')).toEqual({ consumed: false, paymentId: null });
      expect(tx.paymentUploadToken.updateMany).not.toHaveBeenCalled();
    });
  });
});
