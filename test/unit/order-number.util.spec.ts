import { Prisma } from '@prisma/client';
import {
  CROCKFORD_ALPHABET,
  ORDER_NUMBER_SUFFIX_LENGTH,
  generateOrderNumber,
  isOrderNumberConflict,
} from '../../src/modules/orders/order-number.util';

const FORMAT = /^BN-\d{8}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

function p2002(target: unknown) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target },
  });
}

describe('order-number.util', () => {
  describe('generateOrderNumber', () => {
    it('matches BN-YYYYMMDD-XXXXXXXX with a Crockford Base32 suffix', () => {
      expect(generateOrderNumber()).toMatch(FORMAT);
    });

    it('uses the given date for the prefix', () => {
      expect(generateOrderNumber(new Date('2026-06-12T10:00:00.000Z'))).toMatch(/^BN-20260612-/);
    });

    it('suffix is exactly 8 chars and only uses the Crockford alphabet (no I/L/O/U)', () => {
      const suffix = generateOrderNumber().split('-')[2];
      expect(suffix).toHaveLength(ORDER_NUMBER_SUFFIX_LENGTH);
      for (const ch of suffix) {
        expect(CROCKFORD_ALPHABET).toContain(ch);
      }
      expect(suffix).not.toMatch(/[ILOU]/);
    });

    it('produces unique numbers under burst generation (same millisecond)', () => {
      const fixedNow = new Date('2026-06-12T10:00:00.000Z'); // identical timestamp for every call
      const count = 10_000;
      const numbers = new Set(Array.from({ length: count }, () => generateOrderNumber(fixedNow)));
      // The old Date.now()%100000 scheme would collide heavily here; the random suffix does not.
      expect(numbers.size).toBe(count);
    });
  });

  describe('isOrderNumberConflict', () => {
    it('is true for a P2002 on the orderNumber column', () => {
      expect(isOrderNumberConflict(p2002(['orderNumber']))).toBe(true);
      expect(isOrderNumberConflict(p2002('Order_orderNumber_key'))).toBe(true);
    });

    it('is false for a P2002 on a different constraint (e.g. voucher-per-user)', () => {
      expect(isOrderNumberConflict(p2002(['voucherId', 'userId']))).toBe(false);
    });

    it('is false for non-P2002 and non-Prisma errors', () => {
      expect(
        isOrderNumberConflict(
          new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: '6.19.3' }),
        ),
      ).toBe(false);
      expect(isOrderNumberConflict(new Error('boom'))).toBe(false);
      expect(isOrderNumberConflict(undefined)).toBe(false);
    });
  });
});
