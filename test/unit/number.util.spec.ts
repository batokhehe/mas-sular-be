import { finiteInt, intOr, nonNegativeInt, num, numOrZero, positiveInt } from '../../src/common/utils/number.util';

describe('number.util (M3 — shared numeric helpers, four preserved semantics)', () => {
  it('positiveInt: > 0 required; zero/negative/invalid/decimal handled', () => {
    expect(positiveInt('50', 10)).toBe(50);
    expect(positiveInt('50.9', 10)).toBe(50); // truncated, never rounded
    expect(positiveInt('0', 10)).toBe(10); // zero NOT allowed
    expect(positiveInt('-5', 10)).toBe(10);
    expect(positiveInt('abc', 10)).toBe(10);
    expect(positiveInt(undefined, 10)).toBe(10);
    expect(positiveInt('9007199254740991', 1)).toBe(9007199254740991); // large
    expect(intOr).toBe(positiveInt); // legacy alias
  });

  it('nonNegativeInt: zero allowed (0 = disabled toggles)', () => {
    expect(nonNegativeInt('0', 10)).toBe(0);
    expect(nonNegativeInt('-1', 10)).toBe(10);
    expect(nonNegativeInt('7.7', 10)).toBe(7);
    expect(nonNegativeInt(undefined, 10)).toBe(10);
  });

  it('finiteInt: any finite integer incl. negatives', () => {
    expect(finiteInt('-3', 10)).toBe(-3);
    expect(finiteInt('0', 10)).toBe(0);
    expect(finiteInt('2.9', 10)).toBe(2);
    expect(finiteInt('Infinity', 10)).toBe(10);
    expect(finiteInt('x', 10)).toBe(10);
  });

  it('num: raw-SQL coercion — bigint/null → number, NaN passes through', () => {
    expect(num(BigInt(42))).toBe(42);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num('12.5')).toBe(12.5);
    expect(num(-7)).toBe(-7);
    expect(Number.isNaN(num('garbage'))).toBe(true); // deliberately visible
  });

  it('numOrZero: display-safe — NaN collapses to 0', () => {
    expect(numOrZero(BigInt(9))).toBe(9);
    expect(numOrZero(null)).toBe(0);
    expect(numOrZero('garbage')).toBe(0);
    expect(numOrZero('3')).toBe(3);
    expect(numOrZero(-2)).toBe(-2);
  });
});
