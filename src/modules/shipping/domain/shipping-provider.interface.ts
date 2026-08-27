import type { PaxelBoxSize } from './paxel-box';

export interface ShippingRateRequest {
  originPostalCode: string;
  destinationPostalCode: string;
  weightGram: number;
  // Master-address NAMES, not ids: couriers key off human place names. Paxel's
  // /rates/city marks destination address/province/city/district and origin
  // city/district as required, so a provider that needs them reads them here.
  // Optional throughout - JNE and the legacy callers never set them, and a
  // provider that requires one must fail loudly rather than substitute a
  // postal code (see PaxelProvider.requireAddress).
  originAddress?: string;
  originProvince?: string;
  originCity?: string;
  originDistrict?: string;
  originVillage?: string;
  destinationAddress?: string;
  destinationProvince?: string;
  destinationCity?: string;
  destinationDistrict?: string;
  destinationVillage?: string;
  // Real geo data from the active outlet (origin) and customer address
  // (destination). Optional so existing providers/tests remain valid; providers
  // that need coordinates read them here.
  originLatitude?: number;
  originLongitude?: number;
  destinationLatitude?: number;
  destinationLongitude?: number;
  originName?: string;
  /**
   * The box the WHOLE ORDER ships in, chosen from TOTAL ORDER QUANTITY by
   * `selectPaxelBox()` - never from this request's own weight/address fields,
   * and never per-item.
   *
   * Three distinct states, and the difference matters:
   *
   * - ABSENT   the caller computed no box (JNE-only paths, legacy callers,
   *            existing tests). PaxelProvider falls back to
   *            PAXEL_DEFAULT_DIMENSION exactly as before this field existed.
   * - a size   the order fits that box; it drives the RATE `dimension`.
   * - null     the caller DID compute, and the quantity fits no supported box
   *            (>20, XL being out of scope). Paxel cannot carry the order, so
   *            the provider returns no quotes rather than pricing a box the
   *            order does not fit.
   *
   * Absent and null are deliberately NOT the same. Every caller that computes a
   * box assigns `selectPaxelBox()` straight into this field, and that returns
   * `PaxelBoxSize | null` - never undefined - so the two can never be confused.
   */
  paxelBoxSize?: PaxelBoxSize | null;
}

/** Legacy single-rate shape (kept for the /shipping/rates endpoint and the
 *  courier-based fallback). New code should prefer ShippingQuote. */
export interface ShippingRate {
  provider: string;
  service: string;
  cost: number;
  etd: string;
}

/**
 * A single selectable shipping option returned by a provider's getRates(). This is
 * the shape the checkout displays and snapshots onto the order.
 */
export interface ShippingQuote {
  provider: string; // machine name, e.g. 'paxel'
  service: string; // service code, e.g. 'SAME_DAY'
  serviceName: string; // human label, e.g. 'Paxel Same Day'
  estimatedDays: string; // human ETA, e.g. 'Today', '2-3 Days'
  shippingCost: number; // in IDR
  /**
   * Paxel's own `fixed_size` - the price bucket THEIR API resolved
   * server-side from the dimension we sent. This is the PROVIDER's answer and
   * is kept separate from our local PaxelBoxSize selection; the two are never
   * conflated with each other. Absent for providers that don't return one
   * (JNE) or when Paxel's response didn't include it.
   */
  fixedSize?: string;
}

export interface TrackingResult {
  provider: string;
  trackingNumber: string;
  status: string;
  history: Array<{ timestamp: string; description: string }>;
}

/**
 * A shipping courier integration. New couriers (J&T, SiCepat, Anteraja, POS
 * Indonesia, …) implement this interface and are registered in the shipping
 * module's provider list — the checkout never changes (see ShippingProviderFactory).
 */
export interface ShippingProvider {
  readonly name: string;
  /** Return every service this courier offers for the request. */
  getRates(request: ShippingRateRequest): Promise<ShippingQuote[]>;
  track(trackingNumber: string): Promise<TrackingResult>;
}
