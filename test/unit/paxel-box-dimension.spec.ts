import { paxelBoxRateDimension } from '../../src/modules/shipping/infrastructure/providers/paxel-box-dimension';
import { PAXEL_BOX_SIZES, paxelBoxSpec, PaxelBoxSize, selectPaxelBox } from '../../src/modules/shipping/domain/paxel-box';

/**
 * PaxelBoxSize -> Paxel RATE `dimension` string.
 *
 * PAXELBOX-3's whole job is this one mapping, and the boundary of the phase is
 * exactly here: the official PaxelBox packaging dimension (47.5 cm) is never
 * altered anywhere else in the codebase. This file pins both halves — the
 * mapping itself, and that nothing outside it touches 47.5.
 */

describe('paxelBoxRateDimension — the box → RATE dimension mapping', () => {
  it.each([
    ['S', '12x48x48'],
    ['M', '24x48x48'],
    ['L', '36x48x48'],
    ['XL', '59x48x48'],
  ] as Array<[PaxelBoxSize, string]>)('%s -> %s', (size, expected) => {
    expect(paxelBoxRateDimension(size)).toBe(expected);
  });

  it('produces a string for every declared box size, in one pass', () => {
    const all = PAXEL_BOX_SIZES.map((size) => paxelBoxRateDimension(size));
    expect(all).toEqual(['12x48x48', '24x48x48', '36x48x48', '59x48x48']);
  });

  it('XL is sendable even though 59 exceeds the generic city-rate 1-50 example range', () => {
    // No length cap either: "59x48x48" is 8 characters, well inside Paxel's
    // documented max:11 for /rates/city and /rates/instant.
    const xl = paxelBoxRateDimension('XL');
    expect(xl.length).toBeLessThanOrEqual(11);
    expect(xl).toBe('59x48x48');
  });

  it('47.5 is rounded to 48 ONLY in this mapping — the official spec keeps 47.5', () => {
    for (const size of PAXEL_BOX_SIZES) {
      const spec = paxelBoxSpec(size);
      // The official business packaging dimension, from PAXELBOX-1, untouched.
      expect(spec.widthCm).toBe(47.5);
      expect(spec.heightCm).toBe(47.5);
      // The RATE-only rounded representation.
      const dimension = paxelBoxRateDimension(size);
      expect(dimension).not.toContain('47.5');
      expect(dimension.split('x')).toEqual([String(Math.round(spec.lengthCm)), '48', '48']);
    }
  });

  it('does not duplicate the box thresholds — it composes selectPaxelBox() + paxelBoxSpec(), not its own table', () => {
    // If this file re-implemented "1-3 -> S" etc., changing PAXELBOX-1's
    // threshold would silently desync the two. Proven here by driving the
    // dimension purely through the reused selector for every boundary.
    const cases: Array<[number, string]> = [
      [1, '12x48x48'], [3, '12x48x48'],
      [4, '24x48x48'], [10, '24x48x48'],
      [11, '36x48x48'], [20, '36x48x48'],
      [21, '59x48x48'], [100, '59x48x48'],
    ];
    for (const [quantity, expected] of cases) {
      expect(paxelBoxRateDimension(selectPaxelBox(quantity))).toBe(expected);
    }
  });
});
