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
