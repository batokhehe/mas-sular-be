export interface ShippingRateRequest {
  originPostalCode: string;
  destinationPostalCode: string;
  weightGram: number;
}

export interface ShippingRate {
  provider: string;
  service: string;
  cost: number;
  etd: string;
}

export interface TrackingResult {
  provider: string;
  trackingNumber: string;
  status: string;
  history: Array<{ timestamp: string; description: string }>;
}

export interface ShippingProvider {
  readonly name: string;
  calculateRates(request: ShippingRateRequest): Promise<ShippingRate[]>;
  track(trackingNumber: string): Promise<TrackingResult>;
}
