/**
 * PaxelBox — the outer packaging Mas Sular ships in, and the rule that picks one.
 *
 * The rule is a FIXED business decision: the box is chosen from TOTAL PRODUCT
 * QUANTITY across the whole order and nothing else. It deliberately ignores SKU,
 * product dimensions, product volume and weight — three drinks and three frozen
 * packs both ship in an S. That is intentional and is not an approximation of a
 * packing algorithm.
 *
 *   1-3   -> S
 *   4-10  -> M
 *   11-20 -> L
 *   >20   -> XL
 *
 * PURE: no database, no Prisma, no HTTP, no config, no Product, no OrderItem,
 * no provider. Deterministic for a given quantity.
 *
 * SCOPE: this module knows the boxes and the rule. It deliberately does NOT
 * produce a Paxel `dimension` request string — the wire format for a 47.5 cm
 * side is unresolved (Paxel documents `dimension` as max:11 characters, and
 * "12x47.5x47.5" is 12), so formatting is left to a later phase rather than
 * guessed at here. The dimensions below are business data only.
 */

/** Every box Paxel documents, smallest first. Reference data, NOT the selectable set. */
export const PAXEL_BOX_SIZES = ['S', 'M', 'L', 'XL'] as const;

/**
 * The boxes this application will actually put an order in, smallest first.
 * Order matters: `selectPaxelBox` walks it in order and takes the first fit.
 *
 * XL is deliberately EXCLUDED. It is out of scope as a business decision, and
 * Paxel rejected its 59 cm depth on the city-rate endpoint during staging QA,
 * so selecting it would produce an order that cannot be priced. Its spec stays
 * in `SPECS` because the dimension is real and `paxelBoxSpec('XL')` remains a
 * truthful lookup — it just can never be chosen.
 */
export const SELECTABLE_PAXEL_BOX_SIZES = ['S', 'M', 'L'] as const;

export type PaxelBoxSize = (typeof PAXEL_BOX_SIZES)[number];

export interface PaxelBoxSpec {
  /**
   * Highest total quantity this box holds. `null` on XL: it is the open-ended
   * top of the rule (">20"), so it has no upper bound to check.
   */
  maxQuantity: number | null;
  /** Outer packaging dimensions in cm. NOT product dimensions. */
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

/**
 * Every box shares a 47.5 x 47.5 cm face and differs only in depth. Kept as
 * separate numeric fields rather than a formatted string so that nothing here
 * depends on the unresolved Paxel dimension wire format.
 */
const SPECS: Record<PaxelBoxSize, PaxelBoxSpec> = {
  S: { maxQuantity: 3, lengthCm: 12, widthCm: 47.5, heightCm: 47.5 },
  M: { maxQuantity: 10, lengthCm: 24, widthCm: 47.5, heightCm: 47.5 },
  L: { maxQuantity: 20, lengthCm: 36, widthCm: 47.5, heightCm: 47.5 },
  XL: { maxQuantity: null, lengthCm: 59, widthCm: 47.5, heightCm: 47.5 },
};

export function paxelBoxSpec(size: PaxelBoxSize): PaxelBoxSpec {
  return SPECS[size];
}

export function isPaxelBoxSize(value: string): value is PaxelBoxSize {
  return (PAXEL_BOX_SIZES as readonly string[]).includes(value);
}

/**
 * Pick the box for an order's total quantity.
 *
 * `totalQuantity` is the SUM of every OrderItem quantity, not the number of
 * lines and not the number of distinct SKUs.
 *
 * Throws on a quantity that is not a positive integer. This is an assertion
 * about impossible input, NOT a business rule: checkout already guarantees a
 * positive integer (`@IsInt() @Min(1)` on each line, "Cart is empty" for zero
 * lines, and `OrderItem.quantity` is a non-null Int), so 0, negatives and
 * fractions are unreachable through the application. The business rule defines
 * no box for them, and returning S anyway would invent one — refusing is the
 * only answer that does not fabricate business meaning. This mirrors how the
 * Paxel provider already rejects out-of-contract numbers (`assertRange`,
 * `paxelCreateServiceType`) rather than clamping them.
 */
export function selectPaxelBox(totalQuantity: number): PaxelBoxSize | null {
  if (!Number.isInteger(totalQuantity) || totalQuantity < 1) {
    throw new RangeError(
      `PaxelBox requires a total quantity of at least 1 whole item (got ${totalQuantity})`,
    );
  }

  for (const size of SELECTABLE_PAXEL_BOX_SIZES) {
    const { maxQuantity } = SPECS[size];
    // Every selectable box is bounded, so this never falls through to XL.
    if (maxQuantity !== null && totalQuantity <= maxQuantity) return size;
  }

  // Past L (>20). XL is out of scope, and no smaller box fits, so there is no
  // PaxelBox for this order. Returning null says exactly that; returning XL
  // would ship an out-of-scope box and returning S/M/L would understate the
  // parcel. The caller decides what to do with "Paxel cannot take this".
  return null;
}
