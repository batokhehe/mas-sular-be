import { Inject, Injectable, Logger } from '@nestjs/common';
import { PermanentError } from '../../domain/shipping-errors';
import { ShippingProvider, ShippingQuote, ShippingRateRequest, TrackingResult } from '../../domain/shipping-provider.interface';
import { SHIPPING_CONFIG, ShippingConfig } from '../../shipping.config';
import {
  defaultShippingHttpClient,
  executeShippingRequest,
  ShippingHttpClient,
} from '../http/shipping-http-client';
import {
  PAXEL_MIN_WEIGHT_GRAM,
  PAXEL_SERVICES,
  PaxelServiceCode,
  paxelServiceSpec,
} from './paxel-rate.map';

const TRACK_PATH = '/shipments';

/** Paxel address block. Field names are Paxel's, and never leave this file. */
interface PaxelAddress {
  address: string;
  province: string;
  city: string;
  district: string;
  village?: string;
  zip_code?: string;
  longitude?: number;
  latitude?: number;
}

/**
 * Minimal projection of the Paxel rate response.
 *
 * `fixed_price` is the field to read, and it is the ONLY one. Paxel returns
 * small/medium/large/custom_price alongside it, but it also returns
 * `fixed_price_type: "dimension"` and `fixed_size` - it resolves the bucket
 * itself from the dimension in the request and reports which one it picked.
 * Verified across all six saved rate examples in the collection: `fixed_price`
 * always equals the bucket named by `fixed_size` (30x35x20 resolves to "large",
 * not "small"). Picking a bucket client-side would be guessing at the price a
 * customer is charged.
 */
interface PaxelRateResponse {
  data?: {
    fixed_price?: number;
    time_detail?: Array<{ time_delivery_start?: string; time_delivery_end?: string }>;
  };
}

/**
 * Paxel rate integration.
 *
 * One HTTP call per service, because Paxel prices a single `service_type` per
 * request and INSTANT lives on its own endpoint. Failures are per-service: a
 * service that errors contributes no quote rather than failing the whole
 * checkout, which matches how getQuotes aggregates providers.
 */
@Injectable()
export class PaxelProvider implements ShippingProvider {
  readonly name = 'paxel';
  private readonly logger = new Logger('PaxelProvider');
  private http: ShippingHttpClient = defaultShippingHttpClient;

  constructor(@Inject(SHIPPING_CONFIG) private readonly config: ShippingConfig) {}

  private get cfg() {
    return this.config.paxel;
  }

  async getRates(request: ShippingRateRequest): Promise<ShippingQuote[]> {
    if (!this.cfg.enabled) return this.config.allowMockRates ? this.mockRates(request) : [];

    const quotes = await Promise.all(
      PAXEL_SERVICES.map(async (service) => {
        try {
          return await this.rateFor(service, request);
        } catch (error) {
          // Logged by executeShippingRequest already; one unavailable service
          // must not remove the others from checkout.
          this.logger.warn({
            provider: this.name,
            service,
            outcome: 'unavailable',
            errorClass: error instanceof PermanentError ? 'permanent' : 'transient',
          });
          return null;
        }
      }),
    );

    return quotes.filter((quote): quote is ShippingQuote => quote !== null);
  }

  /** One priced service. Throws rather than returning a quote we cannot stand behind. */
  private async rateFor(service: PaxelServiceCode, request: ShippingRateRequest): Promise<ShippingQuote> {
    const spec = paxelServiceSpec(service);
    const origin = this.buildAddress(request, 'origin');
    const destination = this.buildAddress(request, 'destination');
    const weight = this.assertWeight(request.weightGram, spec.maxWeightGram, service);

    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${spec.path}`,
      init: {
        method: 'POST',
        headers: {
          'X-Paxel-API-Key': this.cfg.apiKey ?? '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          origin,
          destination,
          weight,
          dimension: this.cfg.defaultDimension,
          service_type: spec.serviceType,
        }),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      // City/district only - never the street address, which is customer data.
      logBase: { provider: this.name, origin: origin.city, destination: destination.city, service },
    });

    return this.mapResponse(text, service, spec.label);
  }

  /**
   * Paxel marks destination address/province/city/district and origin
   * city/district as required. A postal code is NOT a substitute - sending a
   * blank or improvised name would return a price for the wrong place, so a
   * missing component fails before any HTTP call.
   */
  private buildAddress(request: ShippingRateRequest, side: 'origin' | 'destination'): PaxelAddress {
    const pick = (o: string | undefined, d: string | undefined) => (side === 'origin' ? o : d);
    const address = pick(request.originAddress, request.destinationAddress);
    const province = pick(request.originProvince, request.destinationProvince);
    const city = pick(request.originCity, request.destinationCity);
    const district = pick(request.originDistrict, request.destinationDistrict);

    const missing: string[] = [];
    // Paxel requires origin.city/district; destination additionally requires address+province.
    if (!city) missing.push(`${side}.city`);
    if (!district) missing.push(`${side}.district`);
    if (side === 'destination') {
      if (!address) missing.push('destination.address');
      if (!province) missing.push('destination.province');
    }
    if (missing.length) {
      throw new PermanentError(`Paxel rate request is missing required address fields: ${missing.join(', ')}`, this.name);
    }

    const village = pick(request.originVillage, request.destinationVillage);
    const zip = side === 'origin' ? request.originPostalCode : request.destinationPostalCode;
    const latitude = side === 'origin' ? request.originLatitude : request.destinationLatitude;
    const longitude = side === 'origin' ? request.originLongitude : request.destinationLongitude;

    // Optional keys are omitted rather than sent as undefined/empty.
    return {
      address: address ?? '',
      province: province ?? '',
      city: city as string,
      district: district as string,
      ...(village ? { village } : {}),
      ...(zip ? { zip_code: zip } : {}),
      ...(typeof latitude === 'number' ? { latitude } : {}),
      ...(typeof longitude === 'number' ? { longitude } : {}),
    };
  }

  /**
   * Paxel documents `weight` as between:1,5000 (city) and between:1,25000
   * (instant), in grams - which is already the application's unit, so there is
   * no conversion here, only a bound check. Over the cap is a real failure: the
   * parcel genuinely cannot ship on that service, and clamping it would quote a
   * price for a parcel we are not sending.
   */
  private assertWeight(weightGram: number, maxWeightGram: number, service: string): number {
    if (!Number.isFinite(weightGram) || weightGram < PAXEL_MIN_WEIGHT_GRAM || weightGram > maxWeightGram) {
      throw new PermanentError(
        `Parcel weight ${weightGram}g is outside Paxel ${service} limits (${PAXEL_MIN_WEIGHT_GRAM}-${maxWeightGram}g)`,
        this.name,
      );
    }
    return Math.round(weightGram);
  }

  /** Parse + map. No raw provider response escapes this class. */
  private mapResponse(text: string, service: PaxelServiceCode, label: string): ShippingQuote {
    let parsed: PaxelRateResponse;
    try {
      parsed = JSON.parse(text) as PaxelRateResponse;
    } catch {
      throw new PermanentError(`Paxel returned a malformed rate response for ${service}`, this.name);
    }

    const price = parsed.data?.fixed_price;
    // No fallback to another price field: if Paxel did not resolve a price, we
    // do not have one. A zero-cost quote would be charged to the customer.
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw new PermanentError(`Paxel rate response for ${service} has no usable fixed_price`, this.name);
    }

    return {
      provider: this.name,
      service,
      serviceName: label,
      estimatedDays: this.estimatedDays(parsed),
      shippingCost: Math.round(price),
    };
  }

  /** Paxel expresses ETA as delivery windows, not day counts. */
  private estimatedDays(parsed: PaxelRateResponse): string {
    const window = parsed.data?.time_detail?.[0];
    if (window?.time_delivery_start && window.time_delivery_end) {
      return `${window.time_delivery_start.slice(0, 5)}-${window.time_delivery_end.slice(0, 5)}`;
    }
    return 'Today';
  }

  /** Deterministic stand-in quotes for local/dev when Paxel is disabled. Never in production. */
  private mockRates(request: ShippingRateRequest): ShippingQuote[] {
    const weightKg = Math.max(1, Math.ceil(request.weightGram / 1000));
    return [
      { provider: this.name, service: 'PAXEL_SAMEDAY', serviceName: 'Paxel Same Day (Mock)', estimatedDays: 'Today', shippingCost: 15000 * weightKg },
      { provider: this.name, service: 'PAXEL_NEXTDAY', serviceName: 'Paxel Next Day (Mock)', estimatedDays: '1 Day', shippingCost: 10000 * weightKg },
    ];
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    if (!this.cfg.enabled) {
      return { provider: this.name, trackingNumber, status: 'UNKNOWN', history: [] };
    }
    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${TRACK_PATH}/${encodeURIComponent(trackingNumber)}`,
      init: {
        method: 'GET',
        headers: { 'X-Paxel-API-Key': this.cfg.apiKey ?? '' },
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'TRACK' },
    });
    const status = ((): string => {
      try {
        return (JSON.parse(text) as { data?: { latest_status?: string } }).data?.latest_status ?? 'UNKNOWN';
      } catch {
        return 'UNKNOWN';
      }
    })();
    return { provider: this.name, trackingNumber, status, history: [] };
  }
}
