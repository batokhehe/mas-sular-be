/**
 * Shared numeric parsing/coercion helpers (architecture audit M3). PURE — no
 * env access, no I/O. Four variants exist because call sites deliberately
 * differ; centralizing must NOT merge their semantics:
 *
 *  - positiveInt   env int, > 0 required   (batch sizes, intervals, lease ms)
 *  - nonNegativeInt env int, >= 0 allowed  (0 = "disabled" toggles)
 *  - finiteInt      env int, any finite    (may legitimately be negative)
 *  - num            raw-SQL aggregate coercion (bigint/Decimal/null → number;
 *                   NaN passes through so a bad cast is visible)
 *  - numOrZero      like num but collapses NaN to 0 (display-safe totals)
 */

/** Parse an env-style string as a POSITIVE integer, else the fallback. */
export function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/** Legacy alias — several configs name the same semantics `intOr`. */
export const intOr = positiveInt;

/** Parse an env-style string as a NON-NEGATIVE integer (0 allowed), else the fallback. */
export function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

/** Parse an env-style string as ANY finite integer (sign allowed), else the fallback. */
export function finiteInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/** Coerce raw-SQL values (bigint / Decimal / string / null) to a number; null/undefined → 0. */
export function num(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (v === null || v === undefined) return 0;
  return Number(v);
}

/** Like `num`, but any non-numeric input (incl. NaN) collapses to 0. */
export function numOrZero(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  return Number(v ?? 0) || 0;
}
