import { ShipmentStatus } from '@prisma/client';

export interface ShipmentEndpoint {
  name: string;
  phone?: string;
  addressDetail?: string;
  postalCode: string;
  latitude?: number;
  longitude?: number;
}

export interface CreateShipmentInput {
  orderId: string;
  orderNumber: string;
  service: string; // service code, e.g. 'REG' / 'SAME_DAY'
  serviceName?: string;
  weightGram: number;
  origin: ShipmentEndpoint;
  destination: ShipmentEndpoint;
}

export interface CreateShipmentResult {
  trackingNumber: string;
  providerShipmentId: string;
  /** Normalized status right after booking. */
  status: ShipmentStatus;
  /** Raw provider response, snapshotted onto the shipment (never returned to clients). */
  rawPayload: unknown;
}

export interface ShipmentTrackingResult {
  status: ShipmentStatus;
  rawPayload: unknown;
}

/** Raw provider status for the ShipmentStatusMapper to translate. */
export interface RawTrackingResult {
  providerStatus: string;
  rawPayload: unknown;
}

/**
 * A courier's *fulfillment* API (distinct from the quotation ShippingProvider).
 * New couriers implement this and register in the shipment module provider list —
 * the ShipmentService/factory never change.
 */
export interface ShipmentProvider {
  readonly name: string;
  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  cancelShipment(providerShipmentId: string): Promise<void>;
  trackShipment(trackingNumber: string): Promise<ShipmentTrackingResult>;
  /** Raw provider status (unmapped) for the ShipmentStatusMapper. */
  trackShipmentRaw(trackingNumber: string): Promise<RawTrackingResult>;
}
