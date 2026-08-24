import { PaxelBoxSize, paxelBoxSpec } from '../../domain/paxel-box';

/**
 * PaxelBoxSize -> Paxel RATE `dimension` request string.
 *
 * This is the ONE place a PaxelBox becomes a Paxel wire value, and the ONLY
 * place 47.5 is ever rounded. Paxel's `dimension` field is a plain string and
 * every example in the Postman collection is whole centimetres - there is no
 * evidence it accepts a fractional value, so the officially fixed 47.5 cm
 * width/height is rounded to 48 for this request field alone.
 *
 * This does NOT change the official PaxelBox packaging dimension (still
 * 47.5 cm in `paxel-box.ts`), and it has nothing to do with Product/OrderItem
 * physical data - those remain the CONTENTS, this is the OUTER CARTON, and
 * Paxel CREATE never reads this string at all (create has no top-level
 * dimension field; it prices/ships on per-item weight and L/W/H).
 *
 *   S  -> "12x48x48"
 *   M  -> "24x48x48"
 *   L  -> "36x48x48"
 *   XL -> "59x48x48"
 *
 * XL's 59 cm side deliberately is NOT run through `isPaxelDimension` (that
 * validator's 1-50 range guards the unrelated PAXEL_DEFAULT_DIMENSION env
 * fallback) - a real PaxelBox must be sendable even though it exceeds the
 * generic city-rate example range.
 */
export function paxelBoxRateDimension(size: PaxelBoxSize): string {
  const spec = paxelBoxSpec(size);
  const side = (cm: number) => Math.round(cm);
  return `${side(spec.lengthCm)}x${side(spec.widthCm)}x${side(spec.heightCm)}`;
}
