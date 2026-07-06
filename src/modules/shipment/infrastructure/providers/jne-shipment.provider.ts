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

const GENERATE_PATH = '/tracing/api/generatecnote';
const CANCEL_PATH = '/tracing/api/cancelcnote';
const TRACK_PATH = '/tracing/api/list/v1/cnote';

interface JneGenerateResponse {
  detail?: Array<{ cnote_no?: string; status?: string }>;
  cnote?: { cnote_no?: string };
  error?: string;
}

function mapStatus(raw: string | undefined, fallback: ShipmentStatus): ShipmentStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'SUCCESS':
    case 'CREATED':
      return ShipmentStatus.CREATED;
    case 'PICKED_UP':
      return ShipmentStatus.PICKED_UP;
    case 'ON PROCESS':
    case 'IN_TRANSIT':
      return ShipmentStatus.IN_TRANSIT;
    case 'DELIVERED':
      return ShipmentStatus.DELIVERED;
    case 'CANCELLED':
      return ShipmentStatus.CANCELLED;
    case 'FAILED':
      return ShipmentStatus.FAILED;
    default:
      return fallback;
  }
}

/** Real JNE fulfillment integration (create / cancel / track). */
@Injectable()
export class JneShipmentProvider implements ShipmentProvider {
  readonly name = 'jne';
  private readonly logger = new Logger('JneShipmentProvider');
  private http: ShippingHttpClient = defaultShippingHttpClient;

  constructor(@Inject(SHIPPING_CONFIG) private readonly config: ShippingConfig) {}

  private get cfg() {
    return this.config.jne;
  }

  private assertEnabled(): void {
    if (!this.cfg.enabled) {
      throw new PermanentError('JNE fulfillment is disabled (JNE_ENABLED=false)', this.name);
    }
  }

  private auth(extra: Record<string, string>): URLSearchParams {
    return new URLSearchParams({
      username: this.cfg.username ?? '',
      api_key: this.cfg.apiKey ?? '',
      ...extra,
    });
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    this.assertEnabled();
    const weightKg = Math.max(1, Math.ceil(input.weightGram / 1000));
    const form = this.auth({
      order_no: input.orderNumber,
      service_code: input.service,
      weight: String(weightKg),
      origin_code: this.cfg.originCode ?? '',
      destination_zip: input.destination.postalCode,
      receiver_name: input.destination.name,
      receiver_phone: input.destination.phone ?? '',
      receiver_addr: input.destination.addressDetail ?? '',
    });

    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${GENERATE_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: {
        provider: this.name,
        origin: this.cfg.originCode ?? '-',
        destination: input.destination.postalCode,
        service: input.service,
      },
    });

    const parsed = safeParse<JneGenerateResponse>(text);
    const cnote = parsed?.detail?.[0]?.cnote_no ?? parsed?.cnote?.cnote_no;
    if (!cnote) {
      throw new PermanentError(`JNE did not return a cnote (${parsed?.error ?? 'unknown'})`, this.name);
    }
    return {
      trackingNumber: cnote,
      providerShipmentId: cnote,
      status: mapStatus(parsed?.detail?.[0]?.status, ShipmentStatus.CREATED),
      rawPayload: parsed ?? text,
    };
  }

  async cancelShipment(providerShipmentId: string): Promise<void> {
    this.assertEnabled();
    await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${CANCEL_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: this.auth({ cnote_no: providerShipmentId }).toString(),
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
      url: `${this.cfg.baseUrl}${TRACK_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: this.auth({ awb: trackingNumber }).toString(),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'TRACK' },
    });
    const parsed = safeParse<{ cnote?: { pod_status?: string } }>(text);
    return { status: mapStatus(parsed?.cnote?.pod_status, ShipmentStatus.IN_TRANSIT), rawPayload: parsed ?? text };
  }

  /** Raw provider status for the ShipmentStatusMapper (no internal mapping here). */
  async trackShipmentRaw(trackingNumber: string): Promise<RawTrackingResult> {
    this.assertEnabled();
    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${TRACK_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: this.auth({ awb: trackingNumber }).toString(),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'TRACK' },
    });
    const parsed = safeParse<{ cnote?: { pod_status?: string } }>(text);
    return { providerStatus: parsed?.cnote?.pod_status ?? '', rawPayload: parsed ?? text };
  }
}

function safeParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
