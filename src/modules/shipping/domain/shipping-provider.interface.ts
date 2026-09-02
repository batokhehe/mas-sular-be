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
  /**
   * RajaOngkir's OWN numeric district ids for this request (PAXELBOX-45).
   *
   * RajaOngkir prices by its own SUBDISTRICT id — never by postal code, and never
   * by a Kemendagri code. Nothing populates these yet: `Village.rajaOngkirId`
   * exists in the schema but its migration is unapplied and the mapping is
   * still unresolved (PAXELBOX-41A/41B). They are declared here so the boundary
   * is explicit and the JNE provider has a defined input to check, rather than
   * deriving an id from data that cannot produce one.
   *
   * ABSENT is the normal state today and means "no verified RajaOngkir identity
   * for this address" — the provider then returns no quotes. It must never be
   * substituted with a postal code or a guess.
   */
  originRajaOngkirId?: number;
  destinationRajaOngkirId?: number;
  /**
   * The internal District id of the DESTINATION address (PAXELBOX-61S).
   *
   * An id, not a name: JNE prices by its own district-level destination code,
   * and a district NAME is not unique in Indonesia - Lengkong exists in Bandung,
   * Sukabumi and Nganjuk. Resolving by name would price one customer's parcel
   * with another city's tariff, which is precisely the failure the parent-aware
   * mapping was built to prevent.
   *
   * ABSENT means the caller could not identify the district. The JNE provider
   * then returns no quotes; it must never fall back to a postal code, a village
   * id or a guessed JNE code.
   */
  destinationDistrictId?: string;
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
  /**
   * Verbatim provider fields that this contract has nowhere else to put
   * (PAXELBOX-61S). Carried, never interpreted.
   *
   * JNE's tariff response returns `goods_type`, `currency`, `times`, the two ETD
   * bounds and the raw service code/display; `estimatedDays` can hold none of
   * that faithfully, and PAXELBOX-61O measured `etd_from`/`etd_thru` as null on
   * every retail service it saw. Dropping them would destroy the only evidence
   * of what the courier actually said, so they ride along as strings exactly as
   * received - a null stays null, and no suffix (REG15 vs REG19) is rewritten.
   *
   * Display-layer data only. Nothing prices, books or decides from it.
   */
  providerMeta?: Record<string, string | null>;
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
