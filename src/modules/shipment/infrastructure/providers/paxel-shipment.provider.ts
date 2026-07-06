import { Inject, Injectable, Logger } from '@nestjs/common';
import { ShipmentStatus } from '@prisma/client';
import { PermanentError } from '../../../shipping/domain/shipping-errors';
import {
  defaultShippingHttpClient,
  executeShippingRequest,
  ShippingHttpClient,
} from '../../../shipping/infrastructure/http/shipping-http-client';
import { SHIPPING_CONFIG, ShippingConfig } from '../../../shipping/shipping.config';
import {
  CreateShipmentInput,
  CreateShipmentResult,
  RawTrackingResult,
  ShipmentProvider,
  ShipmentTrackingResult,
} from '../../domain/shipment-provider.interface';

const CREATE_PATH = '/v1/shipments';
const CANCEL_PATH = '/v1/shipments';
const TRACK_PATH = '/v1/tracking';

interface PaxelCreateResponse {
  data?: { id?: string; tracking_number?: string; status?: string };
}

/** Maps Paxel's textual status to our ShipmentStatus. */
function mapStatus(raw: string | undefined, fallback: ShipmentStatus): ShipmentStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'CREATED':
    case 'BOOKED':
    case 'CONFIRMED':
      return ShipmentStatus.CREATED;
    case 'PICKED_UP':
    case 'PICKUP':
      return ShipmentStatus.PICKED_UP;
    case 'IN_TRANSIT':
    case 'ON_DELIVERY':
      return ShipmentStatus.IN_TRANSIT;
    case 'DELIVERED':
    case 'COMPLETED':
      return ShipmentStatus.DELIVERED;
    case 'CANCELLED':
    case 'CANCELED':
      return ShipmentStatus.CANCELLED;
    case 'FAILED':
    case 'RETURNED':
      return ShipmentStatus.FAILED;
    default:
      return fallback;
  }
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

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    this.assertEnabled();
    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${CREATE_PATH}`,
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.apiKey ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference_no: input.orderNumber,
          service_type: input.service,
          weight: input.weightGram,
          origin: {
            name: input.origin.name,
            postal_code: input.origin.postalCode,
            latitude: input.origin.latitude,
            longitude: input.origin.longitude,
          },
          destination: {
            name: input.destination.name,
            phone: input.destination.phone,
            address: input.destination.addressDetail,
            postal_code: input.destination.postalCode,
            latitude: input.destination.latitude,
            longitude: input.destination.longitude,
          },
        }),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: {
        provider: this.name,
        origin: input.origin.postalCode,
        destination: input.destination.postalCode,
        service: input.service,
      },
    });

    const parsed = safeParse<PaxelCreateResponse>(text);
    const trackingNumber = parsed?.data?.tracking_number;
    const providerShipmentId = parsed?.data?.id;
    if (!trackingNumber || !providerShipmentId) {
      throw new PermanentError('Paxel response missing tracking_number/id', this.name);
    }
    return {
      trackingNumber,
      providerShipmentId,
      status: mapStatus(parsed?.data?.status, ShipmentStatus.CREATED),
      rawPayload: parsed ?? text,
    };
  }

  async cancelShipment(providerShipmentId: string): Promise<void> {
    this.assertEnabled();
    await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${CANCEL_PATH}/${encodeURIComponent(providerShipmentId)}/cancel`,
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.apiKey ?? ''}` },
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'CANCEL' },
    });
  }

  async trackShipment(trackingNumber: string): Promise<ShipmentTrackingResult> {
    this.assertEnabled();
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
    const parsed = safeParse<{ data?: { status?: string } }>(text);
    return { status: mapStatus(parsed?.data?.status, ShipmentStatus.IN_TRANSIT), rawPayload: parsed ?? text };
  }

  /** Raw provider status for the ShipmentStatusMapper (no internal mapping here). */
  async trackShipmentRaw(trackingNumber: string): Promise<RawTrackingResult> {
    this.assertEnabled();
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
    const parsed = safeParse<{ data?: { status?: string } }>(text);
    return { providerStatus: parsed?.data?.status ?? '', rawPayload: parsed ?? text };
  }
}

function safeParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
