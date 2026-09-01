import { Inject, Injectable, Logger } from '@nestjs/common';
import { ShippingProvider, ShippingQuote, ShippingRateRequest, TrackingResult } from '../../domain/shipping-provider.interface';
import { SHIPPING_CONFIG, ShippingConfig } from '../../shipping.config';
import {
  defaultShippingHttpClient,
  executeShippingRequest,
  ShippingHttpClient,
} from '../http/shipping-http-client';

const TRACK_PATH = '/tracing/api/list/v1/cnote';

/** RajaOngkir cost endpoint, relative to the configured RajaOngkir base URL. */
const RAJAONGKIR_COST_PATH = '/calculate/domestic-cost';
/** We ask RajaOngkir for exactly one courier. This is never widened here. */
const COURIER = 'jne';
/** RajaOngkir's documented `price` parameter. */
const PRICE_MODE = 'lowest';

/** Minimal projection of the RajaOngkir cost response (never leaked outside). */
interface RajaOngkirCostResponse {
  meta?: { message?: string; code?: number; status?: string };
  data?: Array<{
    name?: string;
    code?: string;
    service?: string;
    description?: string;
    cost?: number | string;
    etd?: string;
  }>;
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

  /**
   * JNE quotation, sourced from RajaOngkir (PAXELBOX-45).
   *
   * RajaOngkir is a RATE SOURCE, not a courier: the provider name stays `jne`,
   * the quotes say `jne`, and the order the customer places says `jne`. Nothing
   * downstream — shipment, tracking, admin, reporting — learns that the price
   * came from a third party. Only `getRates` changed; `track()` below still
   * talks to JNE directly, because RajaOngkir has no tracking to offer.
   *
   * Weight is sent in GRAMS. RajaOngkir takes grams natively, so unlike the
   * JNE tariff call this replaced there is no kilogram rounding — a 1,200 g
   * order is priced as 1,200 g rather than being rounded up to 2 kg.
   *
   * Dimensions are NOT sent: the documented contract accepts origin,
   * destination, weight, courier and price only. The S/M/L box therefore
   * continues to affect Paxel alone, exactly as before.
   */
  async getRates(request: ShippingRateRequest): Promise<ShippingQuote[]> {
    const ro = this.config.rajaongkir;
    if (!ro.enabled) return this.config.allowMockRates ? this.mockRates(request) : [];

    // RajaOngkir prices by ITS OWN subdistrict ids, carried here from
    // Village.rajaOngkirId (PAXELBOX-49B). Nothing populates them yet — the
    // migration is unapplied and the mapping unacquired — so this is the normal
    // path today.
    //
    // No quotes rather than a thrown error, deliberately: an unmapped address is
    // an expected, permanent configuration state, not a fault. It is the same
    // answer PaxelProvider already gives for an order that fits no supported box
    // and the same answer this provider already gave while disabled. Throwing
    // would make every checkout in the country raise a provider error until the
    // backfill lands, and — if Paxel also had nothing to offer — turn a
    // legitimate "no couriers here" into a 500.
    //
    // What must never happen is substituting a postal code or a guessed id: a
    // wrong district silently misprices an order the customer then pays.
    const origin = request.originRajaOngkirId;
    const destination = request.destinationRajaOngkirId;
    if (origin === undefined || destination === undefined) {
      this.logger.warn({
        provider: this.name,
        outcome: 'skipped',
        reason: 'missing_rajaongkir_village_id',
        hasOrigin: origin !== undefined,
        hasDestination: destination !== undefined,
      });
      return [];
    }

    const form = new URLSearchParams({
      origin: String(origin),
      destination: String(destination),
      weight: String(Math.max(1, Math.trunc(request.weightGram))),
      courier: COURIER,
      price: PRICE_MODE,
    });

    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${ro.baseUrl}${RAJAONGKIR_COST_PATH}`,
      init: {
        method: 'POST',
        // The key travels in RajaOngkir's `key` header, never in the body or
        // the URL, so it cannot reach a log line or an error message.
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', key: ro.apiKey ?? '' },
        body: form.toString(),
        timeoutMs: ro.timeoutMs,
      },
      // 429 is not retried by the shared client (PAXELBOX-45A) — a daily quota
      // does not reset inside one call. No RajaOngkir-specific retry is added.
      maxRetry: ro.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: String(origin), destination: String(destination), service: 'ALL' },
    });

    return this.mapRajaOngkirResponse(text);
  }

  /**
   * RajaOngkir cost response -> ShippingQuote. Private, so no raw provider
   * response escapes this class.
   *
   * Anything that cannot be mapped truthfully is DROPPED rather than defaulted:
   * a missing service code or an unusable cost would otherwise become a quote
   * the customer could select and pay.
   */
  private mapRajaOngkirResponse(text: string): ShippingQuote[] {
    let parsed: RajaOngkirCostResponse;
    try {
      parsed = JSON.parse(text) as RajaOngkirCostResponse;
    } catch {
      return [];
    }
    // A non-200 envelope is a refusal, not a price list.
    if (parsed?.meta && parsed.meta.code !== 200) return [];

    return (parsed?.data ?? [])
      .map((row) => {
        // Defensive: `courier=jne` was requested, but a courier we did not ask
        // for must never reach checkout labelled as JNE.
        if (row.code && row.code.toLowerCase() !== COURIER) return null;
        const cost = typeof row.cost === 'string' ? Number(row.cost) : row.cost;
        if (!Number.isFinite(cost) || (cost as number) < 0) return null;
        const service = row.service?.trim();
        if (!service) return null;
        return {
          provider: this.name,
          service,
          // `description` is RajaOngkir's human label ("Regular Service").
          serviceName: `JNE ${row.description?.trim() || service}`,
          estimatedDays: row.etd?.trim() || 'N/A',
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
