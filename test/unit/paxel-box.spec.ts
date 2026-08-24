import {
  isPaxelBoxSize,
  paxelBoxSpec,
  PAXEL_BOX_SIZES,
  PaxelBoxSize,
  selectPaxelBox,
} from '../../src/modules/shipping/domain/paxel-box';

/**
 * PaxelBox selection — a FIXED business rule keyed on TOTAL PRODUCT QUANTITY
 * only. SKU, product dimensions, volume and weight are deliberately irrelevant.
 *
 *   1-3 -> S    4-10 -> M    11-20 -> L    >20 -> XL
 *
 * The boundaries are the whole point, so every edge is pinned on both sides:
 * an off-by-one here silently ships the wrong carton.
 */

describe('selectPaxelBox — boundaries', () => {
  it.each([
    [1, 'S'],
    [2, 'S'],
    [3, 'S'],
    [4, 'M'],
    [5, 'M'],
    [10, 'M'],
    [11, 'L'],
    [12, 'L'],
    [20, 'L'],
    [21, 'XL'],
    [22, 'XL'],
    [100, 'XL'],
  ] as Array<[number, PaxelBoxSize]>)('%i pcs -> %s', (quantity, expected) => {
    expect(selectPaxelBox(quantity)).toBe(expected);
  });

  // The four transitions, stated as pairs so a shifted threshold cannot pass.
  it.each([
    [3, 'S', 4, 'M'],
    [10, 'M', 11, 'L'],
    [20, 'L', 21, 'XL'],
  ] as Array<[number, PaxelBoxSize, number, PaxelBoxSize]>)(
    'the boundary between %i (%s) and %i (%s) is exact',
    (lastQty, lastBox, firstQty, firstBox) => {
      expect(selectPaxelBox(lastQty)).toBe(lastBox);
      expect(selectPaxelBox(firstQty)).toBe(firstBox);
    },
  );

  it('never skips a band across the whole 1..60 range', () => {
    const sizes = Array.from({ length: 60 }, (_, i) => selectPaxelBox(i + 1));
    expect(sizes.slice(0, 3)).toEqual(['S', 'S', 'S']);
    expect(sizes.slice(3, 10)).toEqual(Array(7).fill('M'));
    expect(sizes.slice(10, 20)).toEqual(Array(10).fill('L'));
    expect(sizes.slice(20)).toEqual(Array(40).fill('XL'));
  });
});

describe('selectPaxelBox — quantity only', () => {
  /**
   * The rule is intentionally SKU-blind: the selector takes a single number and
   * has no way to see a product. This asserts the property that makes the fixed
   * business rule safe to rely on — the same total always yields the same box,
   * whatever it is made of.
   */
  it('gives the same box for the same total regardless of how it is composed', () => {
    const threeOfOneSku = 3;
    const oneEachOfThreeSkus = 1 + 1 + 1;
    const twoPlusOne = 2 + 1;
    expect(selectPaxelBox(threeOfOneSku)).toBe('S');
    expect(selectPaxelBox(oneEachOfThreeSkus)).toBe('S');
    expect(selectPaxelBox(twoPlusOne)).toBe('S');
  });

  it('a multi-SKU order of 2 + 3 + 4 totals 9 and ships M', () => {
    expect(selectPaxelBox(2 + 3 + 4)).toBe('M');
  });
});

describe('selectPaxelBox — impossible input is refused, not guessed', () => {
  // Checkout guarantees a positive integer (@IsInt/@Min(1), "Cart is empty",
  // OrderItem.quantity is a non-null Int), so these are programmer errors. The
  // business rule defines no box for them and the selector must not invent one.
  it.each([0, -1, -25])('%i throws rather than returning a box', (quantity) => {
    expect(() => selectPaxelBox(quantity)).toThrow(RangeError);
  });

  it.each([2.5, 0.5, 20.1])('non-integer %p throws', (quantity) => {
    expect(() => selectPaxelBox(quantity)).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity])('non-finite %p throws', (quantity) => {
    expect(() => selectPaxelBox(quantity)).toThrow(RangeError);
  });

  it('names the offending quantity in the message', () => {
    expect(() => selectPaxelBox(0)).toThrow(/at least 1 whole item \(got 0\)/);
  });
});

describe('PaxelBox specs — business metadata', () => {
  it('exposes exactly the four sizes, smallest first', () => {
    expect([...PAXEL_BOX_SIZES]).toEqual(['S', 'M', 'L', 'XL']);
  });

  it.each([
    ['S', 3, 12],
    ['M', 10, 24],
    ['L', 20, 36],
  ] as Array<[PaxelBoxSize, number, number]>)(
    '%s holds up to %i pcs and is %i x 47.5 x 47.5',
    (size, maxQuantity, lengthCm) => {
      const spec = paxelBoxSpec(size);
      expect(spec.maxQuantity).toBe(maxQuantity);
      expect(spec.lengthCm).toBe(lengthCm);
      expect(spec.widthCm).toBe(47.5);
      expect(spec.heightCm).toBe(47.5);
    },
  );

  it('XL is open-ended and 59 x 47.5 x 47.5', () => {
    const spec = paxelBoxSpec('XL');
    expect(spec.maxQuantity).toBeNull();
    expect(spec.lengthCm).toBe(59);
    expect(spec.widthCm).toBe(47.5);
    expect(spec.heightCm).toBe(47.5);
  });

  /**
   * Guards the scope boundary of this phase: the Paxel wire format for a 47.5 cm
   * side is unresolved (documented `dimension` is max:11 chars; "12x47.5x47.5"
   * is 12), so this module must not be the place a request string appears.
   */
  it('exposes no Paxel dimension request string', () => {
    for (const size of PAXEL_BOX_SIZES) {
      const spec = paxelBoxSpec(size) as unknown as Record<string, unknown>;
      expect(Object.values(spec).some((v) => typeof v === 'string' && v.includes('x'))).toBe(false);
    }
  });

  it('recognises valid sizes and rejects anything else', () => {
    expect(isPaxelBoxSize('L')).toBe(true);
    expect(isPaxelBoxSize('XXL')).toBe(false);
    expect(isPaxelBoxSize('s')).toBe(false);
  });
});
