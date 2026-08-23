import { Inject, Injectable, Logger } from '@nestjs/common';
import { ShipmentStatus } from '@prisma/client';
import { PermanentError } from '../../../shipping/domain/shipping-errors';
import {
  defaultShippingHttpClient,
  executeShippingRequest,
  ShippingHttpClient,
} from '../../../shipping/infrastructure/http/shipping-http-client';
import { SHIPPING_CONFIG, ShippingConfig } from '../../../shipping/shipping.config';
import { lookupProviderStatus } from '../../shipment-status.mapper';
import { formatPaxelDatetime } from './paxel-datetime';
import { paxelCancelSignature, paxelCreateSignature } from './paxel-signature';
import {
  CreateShipmentInput,
  CreateShipmentResult,
  RawTrackingResult,
  ShipmentEndpoint,
  ShipmentItem,
  ShipmentProvider,
  ShipmentTrackingResult,
} from '../../domain/shipment-provider.interface';

/**
 * Real Paxel paths, from the Postman collection. The base URL already carries
 * `/v1`, so these are appended bare — and tracking is a shipment lookup, not a
 * separate tracking service: the previously guessed `/v1/tracking/:no` does not
 * exist.
 */
const SHIPMENTS_PATH = '/shipments';

/**
 * Sent when a caller does not supply one. Paxel requires a non-empty reason and
 * feeds its first two characters into the signature, so it can never be blank.
 */
export const DEFAULT_CANCELLATION_REASON = 'dibatalkan oleh penjual';

/**
 * Paxel's `payment_type`. The collection documents exactly one accepted value
 * ("CRD", max:3) across every service, and no cash-on-delivery equivalent.
 */
const PAXEL_PAYMENT_TYPE = 'CRD';

/**
 * Create's `service_type` literals.
 *
 * These are NOT the rate literals. The collection's create bodies send
 * "INSTANT", while the rate endpoint sends "INSTANT GOSEND" — reusing the rate
 * map here would send a service Paxel does not recognise on this endpoint.
 */
const PAXEL_CREATE_SERVICE_TYPES: Record<string, string> = {
  PAXEL_INSTANT: 'INSTANT',
  PAXEL_SAMEDAY: 'SAMEDAY',
  PAXEL_NEXTDAY: 'NEXTDAY',
  PAXEL_REGULAR: 'REGULAR',
};

function paxelCreateServiceType(service: string): string {
  const mapped = PAXEL_CREATE_SERVICE_TYPES[service?.toUpperCase()];
  if (!mapped) {
    throw new PermanentError(`Unknown Paxel service '${service}'`, 'paxel');
  }
  return mapped;
}

/** Paxel validates these ranges server-side; failing here saves a doomed round-trip. */
function assertRange(value: number, min: number, max: number, label: string, provider: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new PermanentError(`${label} must be between ${min} and ${max} (got ${value})`, provider);
  }
}

interface PaxelEndpoint {
  name: string;
  phone: string;
  address: string;
  /** Optional: Paxel accepts a shipment with no destination note (verified on staging). */
  note?: string;
  province: string;
  city: string;
  district: string;
  village: string;
  zip_code: string;
  latitude?: number;
  longitude?: number;
}

interface PaxelItem {
  code: string;
  name: string;
  category: string;
  is_fragile: boolean;
  price: number;
  quantity: number;
  weight: number;
  length: number;
  width: number;
  height: number;
}

interface PaxelCreatePayload {
  invoice_number: string;
  payment_type: string;
  invoice_value: number;
  origin: PaxelEndpoint;
  destination: PaxelEndpoint;
  items: PaxelItem[];
  pickup_datetime: string;
  need_insurance: boolean;
  service_type: string;
}

/** Only the field create needs; the whole body is snapshotted into providerPayload. */
interface PaxelCreateResponse {
  data?: { airwaybill_code?: string };
}


/**
 * Paxel's status vocabulary lives in ShipmentStatusMapper, not here — one
 * dictionary, one place to update. Anything it does not recognise becomes the
 * caller's fallback rather than a guess.
 */
function mapStatus(raw: string | undefined, fallback: ShipmentStatus): ShipmentStatus {
  return lookupProviderStatus('paxel', raw ?? '') ?? fallback;
}

/** Real Paxel fulfillment integration (create / cancel / track). */
@Injectable()
export class PaxelShipmentProvider implements ShipmentProvider {
  readonly name = 'paxel';
  private readonly logger = new Logger('PaxelShipmentProvider');
  private http: ShippingHttpClient = defaultShippingHttpClient;

  constructor(@Inject(SHIPPING_CONFIG) private readonly config: ShippingConfig) {}

  private get cfg() {
    return this.config.paxel;
  }

  private assertEnabled(): void {
    if (!this.cfg.enabled) {
      throw new PermanentError('Paxel fulfillment is disabled (PAXEL_ENABLED=false)', this.name);
    }
  }

  readonly requiresPickupSchedule = true;

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    this.assertEnabled();
    const payload = this.buildCreatePayload(input);

    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${SHIPMENTS_PATH}`,
      init: {
        method: 'POST',
        headers: {
          'X-Paxel-API-Key': this.cfg.apiKey ?? '',
          'X-Paxel-Signature': paxelCreateSignature(
            {
              invoiceNumber: payload.invoice_number,
              originName: payload.origin.name,
              destinationName: payload.destination.name,
              // The FIRST item of the array actually sent — the signature is
              // order-sensitive, so it is computed from the built payload.
              firstItemName: payload.items[0].name,
            },
            this.cfg.apiSecret ?? '',
          ),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        timeoutMs: this.cfg.timeoutMs,
      },
      // NEVER retried. Paxel documents no idempotency key, no reference field and
      // no way to detect a replay, so a retry after a lost response can issue a
      // SECOND airwaybill for one order. A failed create is surfaced to a human.
      maxRetry: 0,
      logger: this.logger,
      // City only. Never the street address, phone, recipient name, item names,
      // invoice value, API key, secret or signature.
      logBase: {
        provider: this.name,
        origin: payload.origin.city,
        destination: payload.destination.city,
        service: payload.service_type,
      },
    });

    const parsed = safeParse<PaxelCreateResponse>(text);
    const airwaybill = parsed?.data?.airwaybill_code;
    if (!airwaybill) {
      throw new PermanentError('Paxel create response has no airwaybill_code', this.name);
    }
    return {
      trackingNumber: airwaybill,
      // Paxel returns no separate identifier; the airwaybill IS the handle, and
      // cancel/track already address shipments by it.
      providerShipmentId: airwaybill,
      // The create response carries no status field — a booked shipment is CREATED.
      status: ShipmentStatus.CREATED,
      // shipping_cost rides along in here and ONLY here. Shipment.cost stays the
      // checkout rate snapshot, which is what the customer was charged.
      rawPayload: parsed ?? text,
    };
  }

  /**
   * Domain input to Paxel's documented create body.
   *
   * Everything Paxel marks required is checked here, before any HTTP call. That
   * matters more than usual for create: with no idempotency key, a request that
   * reaches Paxel and then fails locally cannot be safely retried.
   */
  private buildCreatePayload(input: CreateShipmentInput): PaxelCreatePayload {
    // Paxel's merchant create contract has no cash-on-delivery concept —
    // payment_type is documented solely as "CRD". Sending it for a COD order
    // would assert a prepayment that never happened.
    if (input.paymentMethod && input.paymentMethod.toUpperCase() === 'COD') {
      throw new PermanentError('Paxel booking does not support cash-on-delivery orders', this.name);
    }
    if (!input.pickupAtIso) {
      throw new PermanentError('Paxel booking requires an admin-selected pickup date and time', this.name);
    }
    if (!Number.isFinite(input.invoiceValue) || (input.invoiceValue ?? 0) <= 0) {
      throw new PermanentError('Paxel booking requires a positive order value', this.name);
    }

    const items = (input.items ?? []).map((item, index) => this.buildItem(item, index));
    if (items.length === 0) {
      throw new PermanentError('Paxel booking requires at least one order item', this.name);
    }

    return {
      invoice_number: input.orderNumber,
      payment_type: PAXEL_PAYMENT_TYPE,
      invoice_value: input.invoiceValue as number,
      origin: this.buildEndpoint(input.origin, 'origin'),
      destination: this.buildEndpoint(input.destination, 'destination'),
      items,
      pickup_datetime: formatPaxelDatetime(input.pickupAtIso),
      need_insurance: this.cfg.needInsurance,
      service_type: paxelCreateServiceType(input.service),
    };
  }

  /** One parcel line. Physical values come from the OrderItem snapshot or not at all. */
  private buildItem(item: ShipmentItem, index: number): PaxelItem {
    const label = `items[${index}]`;
    const missing: string[] = [];
    if (!item.code) missing.push(`${label}.code`);
    if (!item.name) missing.push(`${label}.name`);
    if (!item.category) missing.push(`${label}.category`);
    // No fallback of any kind: not the rate envelope, not the legacy 500g
    // placeholder. An unmeasured product cannot be booked, only measured.
    if (item.weightGram == null) missing.push(`${label}.weight`);
    if (item.lengthCm == null) missing.push(`${label}.length`);
    if (item.widthCm == null) missing.push(`${label}.width`);
    if (item.heightCm == null) missing.push(`${label}.height`);
    if (missing.length) {
      throw new PermanentError(
        `Paxel booking is missing product physical data: ${missing.join(', ')}. Set the product weight and dimensions, then retry.`,
        this.name,
      );
    }

    assertRange(item.weightGram as number, 1, 5000, `${label}.weight`, this.name);
    assertRange(item.lengthCm as number, 1, 50, `${label}.length`, this.name);
    assertRange(item.widthCm as number, 1, 50, `${label}.width`, this.name);
    assertRange(item.heightCm as number, 1, 50, `${label}.height`, this.name);

    return {
      code: item.code,
      name: item.name,
      category: item.category,
      is_fragile: item.isFragile ?? false,
      price: item.unitPrice,
      quantity: item.quantity,
      weight: item.weightGram as number,
      length: item.lengthCm as number,
      width: item.widthCm as number,
      height: item.heightCm as number,
    };
  }

  /**
   * Paxel marks these required on BOTH endpoints. The origin's phone and note
   * come from configuration — Outlet carries no contact column, and a pickup
   * instruction is an operational fact a person has to supply.
   *
   * `destination.note` is deliberately NOT required. Address.notes is nullable,
   * so demanding it made every order without a customer delivery note
   * unbookable. Staging proved Paxel does not need it: create returned 200 with
   * an airwaybill_code with the key omitted, empty, and null alike. A blank note
   * is omitted from the payload rather than sent as "" — an empty string is a
   * value Paxel would store and show a driver as if it were an instruction.
   */
  private buildEndpoint(endpoint: ShipmentEndpoint, side: 'origin' | 'destination'): PaxelEndpoint {
    const phone = side === 'origin' ? this.cfg.originPhone : endpoint.phone;
    const note = side === 'origin' ? this.cfg.originNote : endpoint.note;

    const missing: string[] = [];
    if (!endpoint.name) missing.push(`${side}.name`);
    if (!phone) missing.push(side === 'origin' ? 'PAXEL_ORIGIN_PHONE' : `${side}.phone`);
    if (!endpoint.addressDetail) missing.push(`${side}.address`);
    if (side === 'origin' && !note) missing.push('PAXEL_ORIGIN_NOTE');
    if (!endpoint.province) missing.push(`${side}.province`);
    if (!endpoint.city) missing.push(`${side}.city`);
    if (!endpoint.district) missing.push(`${side}.district`);
    if (!endpoint.village) missing.push(`${side}.village`);
    if (!endpoint.postalCode) missing.push(`${side}.zip_code`);
    if (missing.length) {
      throw new PermanentError(`Paxel booking is missing required fields: ${missing.join(', ')}`, this.name);
    }

    return {
      name: endpoint.name,
      phone: phone as string,
      address: endpoint.addressDetail as string,
      ...(note && note.trim() ? { note } : {}),
      province: endpoint.province as string,
      city: endpoint.city as string,
      district: endpoint.district as string,
      village: endpoint.village as string,
      zip_code: endpoint.postalCode,
      ...(typeof endpoint.latitude === 'number' ? { latitude: endpoint.latitude } : {}),
      ...(typeof endpoint.longitude === 'number' ? { longitude: endpoint.longitude } : {}),
    };
  }

  /**
   * POST /shipments/:airwaybill_code/cancel
   *
   * The identifier is Paxel's airwaybill code — for Paxel that IS the provider
   * shipment id, since create returns only `airwaybill_code`.
   *
   * Errors propagate. executeShippingRequest throws PermanentError on 4xx and
   * TransientError on 5xx/timeout/network, and a cancellation that Paxel did
   * not accept must never be reported to the caller as success.
   */
  async cancelShipment(airwaybillCode: string, reason: string = DEFAULT_CANCELLATION_REASON): Promise<void> {
    this.assertEnabled();
    const cancellationReason = reason.trim() || DEFAULT_CANCELLATION_REASON;
    await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${SHIPMENTS_PATH}/${encodeURIComponent(airwaybillCode)}/cancel`,
      init: {
        method: 'POST',
        headers: {
          'X-Paxel-API-Key': this.cfg.apiKey ?? '',
          'X-Paxel-Signature': paxelCancelSignature(airwaybillCode, cancellationReason, this.cfg.apiSecret ?? ''),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cancellation_reason: cancellationReason }),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      // No AWB, no reason, no signature in the log context.
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'CANCEL' },
    });
  }

  /**
   * GET /shipments/:airwaybill_code
   *
   * Paxel reports the current state in `data.latest_status` — a short code such
   * as PDO or RTP, not a word. An unrecognised code degrades to UNKNOWN here
   * rather than to a plausible-looking guess like IN_TRANSIT, which would move a
   * shipment forward on no evidence.
   */
  async trackShipment(trackingNumber: string): Promise<ShipmentTrackingResult> {
    const { latestStatus, payload } = await this.fetchShipment(trackingNumber);
    return { status: mapStatus(latestStatus, ShipmentStatus.UNKNOWN), rawPayload: payload };
  }

  /** Raw provider status for the ShipmentStatusMapper (no internal mapping here). */
  async trackShipmentRaw(trackingNumber: string): Promise<RawTrackingResult> {
    const { latestStatus, payload } = await this.fetchShipment(trackingNumber);
    return { providerStatus: latestStatus, rawPayload: payload };
  }

  /** One shipment lookup, shared by both tracking entry points. */
  private async fetchShipment(airwaybillCode: string): Promise<{ latestStatus: string; payload: unknown }> {
    this.assertEnabled();
    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${SHIPMENTS_PATH}/${encodeURIComponent(airwaybillCode)}`,
      init: {
        method: 'GET',
        headers: { 'X-Paxel-API-Key': this.cfg.apiKey ?? '' },
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'TRACK' },
    });
    const parsed = safeParse<PaxelShipmentResponse>(text);
    return { latestStatus: parsed?.data?.latest_status ?? '', payload: parsed ?? text };
  }
}

/** Only the field tracking reads; the rest of Paxel's detail payload is snapshotted as-is. */
interface PaxelShipmentResponse {
  data?: { latest_status?: string };
}

function safeParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
