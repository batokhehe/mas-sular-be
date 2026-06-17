import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';

// Crockford Base32 — excludes I, L, O, U to avoid visual ambiguity on receipts.
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ORDER_NUMBER_SUFFIX_LENGTH = 8; // 8 symbols x 5 bits = 40 bits of entropy

/**
 * Collision-resistant order number: `BMS-YYYYMMDD-XXXXXXXX`, where the suffix is
 * a random Crockford Base32 string. The date prefix scopes uniqueness per day
 * and keeps the value human-readable/sortable; the random suffix removes the
 * time-derived collisions of the old `Date.now() % 100000` scheme.
 */
export function generateOrderNumber(now: Date = new Date()): string {
  const datePart = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `BMS-${datePart}-${randomSuffix(ORDER_NUMBER_SUFFIX_LENGTH)}`;
}

function randomSuffix(length: number): string {
  const bytes = randomBytes(length);
  let suffix = '';
  for (let i = 0; i < length; i += 1) {
    // One byte per symbol; take the low 5 bits → uniform over 32 symbols.
    suffix += CROCKFORD_ALPHABET[bytes[i] & 31];
  }
  return suffix;
}

/**
 * True only when an error is a unique-constraint violation (P2002) on the
 * orderNumber column — so the checkout retry regenerates the suffix without
 * swallowing unrelated unique violations (e.g. voucher-per-user).
 */
export function isOrderNumberConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : target != null ? [String(target)] : [];
  return fields.some((field) => field.toLowerCase().includes('ordernumber'));
}
