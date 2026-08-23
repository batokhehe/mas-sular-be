/**
 * The single place Paxel's rate vocabulary is written down.
 *
 * Every literal here was read off the Paxel eCommerce API Postman collection,
 * not inferred: INSTANT is the odd one out on BOTH axes - it posts to a
 * different endpoint (`/rates/instant`, not `/rates/city`) and its service_type
 * is the two-word `INSTANT GOSEND`. Assuming the obvious `INSTANT` on
 * `/rates/city` would fail against the real API.
 *
 * The domain speaks `PAXEL_SAMEDAY`; only this file knows what Paxel calls it.
 */

/** Domain-facing service codes. The rest of the application uses these. */
export const PAXEL_SERVICES = ['PAXEL_INSTANT', 'PAXEL_SAMEDAY', 'PAXEL_NEXTDAY', 'PAXEL_REGULAR'] as const;

export type PaxelServiceCode = (typeof PAXEL_SERVICES)[number];

export interface PaxelServiceSpec {
  /** Path appended to the configured base URL. */
  path: string;
  /** Exact `service_type` Paxel expects in the request body. */
  serviceType: string;
  /** Human label surfaced to checkout. */
  label: string;
  /**
   * Documented upper bound for `weight`, in grams, for this endpoint. The city
   * endpoint caps at 5000 and instant at 25000 - a parcel over the cap is a
   * hard failure, never a silently clamped request.
   */
  maxWeightGram: number;
}

const CITY_PATH = '/rates/city';
const INSTANT_PATH = '/rates/instant';

/** Paxel documents `weight` as between:1,N per endpoint. */
export const PAXEL_MIN_WEIGHT_GRAM = 1;

const SPECS: Record<PaxelServiceCode, PaxelServiceSpec> = {
  PAXEL_INSTANT: { path: INSTANT_PATH, serviceType: 'INSTANT GOSEND', label: 'Paxel Instant', maxWeightGram: 25_000 },
  PAXEL_SAMEDAY: { path: CITY_PATH, serviceType: 'SAMEDAY', label: 'Paxel Same Day', maxWeightGram: 5_000 },
  PAXEL_NEXTDAY: { path: CITY_PATH, serviceType: 'NEXTDAY', label: 'Paxel Next Day', maxWeightGram: 5_000 },
  PAXEL_REGULAR: { path: CITY_PATH, serviceType: 'REGULAR', label: 'Paxel Regular', maxWeightGram: 5_000 },
};

export function paxelServiceSpec(service: PaxelServiceCode): PaxelServiceSpec {
  return SPECS[service];
}

export function isPaxelServiceCode(value: string): value is PaxelServiceCode {
  return (PAXEL_SERVICES as readonly string[]).includes(value);
}
