import { Inject, Injectable, Logger } from '@nestjs/common';
import { ShippingProvider, ShippingQuote, ShippingRateRequest, TrackingResult } from '../../domain/shipping-provider.interface';
import { SHIPPING_CONFIG, ShippingConfig } from '../../shipping.config';
import {
  defaultShippingHttpClient,
  executeShippingRequest,
  ShippingHttpClient,
} from '../http/shipping-http-client';

const RATE_PATH = '/v1/rates';
const TRACK_PATH = '/v1/tracking';

/** Minimal projection of the Paxel rate response we depend on (never leaked outside). */
interface PaxelRateResponse {
  data?: {
    services?: Array<{
      service_type?: string;
      service_name?: string;
      price?: number;
      estimated_delivery?: string;
    }>;
  };
}

/**
 * Real Paxel courier integration. Authenticates with a Bearer API key, requests
 * rates over HTTP with timeout + retry, classifies errors (see shipping-errors),
 * maps the response to ShippingQuote, and logs without secrets. When disabled it
 * simply contributes no quotes.
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

    const origin = this.resolveOrigin(request.originPostalCode);
    const destination = request.destinationPostalCode;

    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${RATE_PATH}`,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          origin_postal_code: origin,
          destination_postal_code: destination,
          weight: request.weightGram,
        }),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin, destination, service: 'ALL' },
    });

    return this.mapResponse(text);
  }

  /** Parse + map the raw Paxel body to ShippingQuote[]. Kept private so no raw
   *  provider response ever escapes this class. */
  private mapResponse(text: string): ShippingQuote[] {
    let parsed: PaxelRateResponse;
    try {
      parsed = JSON.parse(text) as PaxelRateResponse;
    } catch {
      return [];
    }
    const services = parsed.data?.services ?? [];
    return services
      .filter((s) => typeof s.price === 'number')
      .map((s) => ({
        provider: this.name,
        service: s.service_type ?? 'SAME_DAY',
        serviceName: s.service_name ?? `Paxel ${s.service_type ?? 'Same Day'}`,
        estimatedDays: s.estimated_delivery ?? 'Today',
        shippingCost: Math.round(s.price as number),
      }));
  }

  /** Deterministic stand-in quotes for local/dev when no Paxel credentials are configured. */
  private mockRates(request: ShippingRateRequest): ShippingQuote[] {
    const weightKg = Math.max(1, Math.ceil(request.weightGram / 1000));
    return [
      { provider: this.name, service: 'SAME_DAY', serviceName: 'Paxel Same Day (Mock)', estimatedDays: 'Today', shippingCost: 15000 * weightKg },
      { provider: this.name, service: 'NEXT_DAY', serviceName: 'Paxel Next Day (Mock)', estimatedDays: '1 Day', shippingCost: 10000 * weightKg },
    ];
  }

  private resolveOrigin(requestOrigin: string): string {
    return requestOrigin && requestOrigin !== '00000' ? requestOrigin : this.config.originPostalCode;
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
        headers: { Authorization: `Bearer ${this.cfg.apiKey ?? ''}` },
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'TRACK' },
    });
    const status = ((): string => {
      try {
        return (JSON.parse(text) as { data?: { status?: string } }).data?.status ?? 'IN_TRANSIT';
      } catch {
        return 'IN_TRANSIT';
      }
    })();
    return { provider: this.name, trackingNumber, status, history: [] };
  }
}
