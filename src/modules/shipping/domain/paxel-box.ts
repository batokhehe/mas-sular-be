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

/** Box sizes, smallest first. Order matters: `selectPaxelBox` walks it in order. */
export const PAXEL_BOX_SIZES = ['S', 'M', 'L', 'XL'] as const;

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
export function selectPaxelBox(totalQuantity: number): PaxelBoxSize {
  if (!Number.isInteger(totalQuantity) || totalQuantity < 1) {
    throw new RangeError(
      `PaxelBox requires a total quantity of at least 1 whole item (got ${totalQuantity})`,
    );
  }

  for (const size of PAXEL_BOX_SIZES) {
    const { maxQuantity } = SPECS[size];
    if (maxQuantity === null || totalQuantity <= maxQuantity) return size;
  }

  // Unreachable: XL has no upper bound, so the loop always returns.
  return 'XL';
}
