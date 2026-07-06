import { Inject, Injectable, Logger } from '@nestjs/common';
import { ShippingProvider, ShippingQuote, ShippingRateRequest, TrackingResult } from '../../domain/shipping-provider.interface';
import { SHIPPING_CONFIG, ShippingConfig } from '../../shipping.config';
import {
  defaultShippingHttpClient,
  executeShippingRequest,
  ShippingHttpClient,
} from '../http/shipping-http-client';

const TARIFF_PATH = '/tracing/api/pricedev';
const TRACK_PATH = '/tracing/api/list/v1/cnote';

/** Minimal projection of the JNE tariff response we depend on (never leaked outside). */
interface JneTariffResponse {
  price?: Array<{
    service_code?: string;
    service_display?: string;
    price?: number | string;
    etd_from?: string;
    etd_thru?: string;
  }>;
  error?: string;
}

/**
 * Real JNE courier integration. Authenticates with username + api_key (JNE's
 * form-encoded tariff API), requests a quotation over HTTP with timeout + retry,
 * classifies errors, maps the response to ShippingQuote, and logs without secrets.
 * When disabled it contributes no quotes.
 */
@Injectable()
export class JneProvider implements ShippingProvider {
  readonly name = 'jne';
  private readonly logger = new Logger('JneProvider');
  private http: ShippingHttpClient = defaultShippingHttpClient;

  constructor(@Inject(SHIPPING_CONFIG) private readonly config: ShippingConfig) {}

  private get cfg() {
    return this.config.jne;
  }

  async getRates(request: ShippingRateRequest): Promise<ShippingQuote[]> {
    if (!this.cfg.enabled) return this.config.allowMockRates ? this.mockRates(request) : [];

    const origin = this.cfg.originCode ?? this.config.originPostalCode;
    const destination = request.destinationPostalCode;
    // JNE weight is in kilograms (min 1).
    const weightKg = Math.max(1, Math.ceil(request.weightGram / 1000));

    const form = new URLSearchParams({
      username: this.cfg.username ?? '',
      api_key: this.cfg.apiKey ?? '',
      from: origin,
      thru: destination,
      weight: String(weightKg),
    });

    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${TARIFF_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin, destination, service: 'ALL' },
    });

    return this.mapResponse(text);
  }

  /** Parse + map the raw JNE body to ShippingQuote[]. Private so no raw provider
   *  response escapes this class. */
  private mapResponse(text: string): ShippingQuote[] {
    let parsed: JneTariffResponse;
    try {
      parsed = JSON.parse(text) as JneTariffResponse;
    } catch {
      return [];
    }
    const prices = parsed.price ?? [];
    return prices
      .map((p) => {
        const cost = typeof p.price === 'string' ? Number(p.price) : p.price;
        if (!Number.isFinite(cost)) return null;
        return {
          provider: this.name,
          service: p.service_code ?? 'REG',
          serviceName: `JNE ${p.service_display ?? p.service_code ?? 'Regular'}`,
          estimatedDays: this.formatEtd(p.etd_from, p.etd_thru),
          shippingCost: Math.round(cost as number),
        } satisfies ShippingQuote;
      })
      .filter((q): q is ShippingQuote => q !== null);
  }

  /** Deterministic stand-in quotes for local/dev when no JNE credentials are configured. */
  private mockRates(request: ShippingRateRequest): ShippingQuote[] {
    const weightKg = Math.max(1, Math.ceil(request.weightGram / 1000));
    return [
      { provider: this.name, service: 'REG', serviceName: 'JNE Reguler (Mock)', estimatedDays: '2-3 Days', shippingCost: 9000 * weightKg },
      { provider: this.name, service: 'YES', serviceName: 'JNE Yakin Esok Sampai (Mock)', estimatedDays: '1 Day', shippingCost: 18000 * weightKg },
    ];
  }

  private formatEtd(from?: string, thru?: string): string {
    const f = (from ?? '').trim();
    const t = (thru ?? '').trim();
    if (f && t && f !== t) return `${f}-${t} Days`;
    const single = f || t;
    return single ? `${single} Days` : 'N/A';
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    if (!this.cfg.enabled) {
      return { provider: this.name, trackingNumber, status: 'UNKNOWN', history: [] };
    }
    const form = new URLSearchParams({
      username: this.cfg.username ?? '',
      api_key: this.cfg.apiKey ?? '',
      awb: trackingNumber,
    });
    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${TRACK_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'TRACK' },
    });
    const status = ((): string => {
      try {
        return (JSON.parse(text) as { cnote?: { pod_status?: string } }).cnote?.pod_status ?? 'IN_TRANSIT';
      } catch {
        return 'IN_TRANSIT';
      }
    })();
    return { provider: this.name, trackingNumber, status, history: [] };
  }
}
