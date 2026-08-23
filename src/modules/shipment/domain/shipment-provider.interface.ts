import { ShipmentStatus } from '@prisma/client';

export interface ShipmentEndpoint {
  name: string;
  phone?: string;
  addressDetail?: string;
  postalCode: string;
  latitude?: number;
  longitude?: number;
  /** Delivery/pickup instruction for the courier. */
  note?: string;
  // Master-address NAMES. Couriers address on place names, not ids; Paxel marks
  // province/city/district/village required on both endpoints.
  province?: string;
  city?: string;
  district?: string;
  village?: string;
}

/**
 * One line of the parcel. Physical values come from the OrderItem snapshot taken
 * at checkout, never from the live Product — booking happens after payment, so
 * reading the catalogue now would describe a different parcel than the one the
 * customer ordered. Null means "not measured": a provider that needs the value
 * must refuse to book rather than invent one.
 */
export interface ShipmentItem {
  code: string;
  name: string;
  category: string;
  quantity: number;
  unitPrice: number;
  weightGram: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  isFragile: boolean | null;
}

export interface CreateShipmentInput {
  orderId: string;
  orderNumber: string;
  service: string; // service code, e.g. 'REG' / 'SAME_DAY'
  serviceName?: string;
  weightGram: number;
  origin: ShipmentEndpoint;
  destination: ShipmentEndpoint;
  /** Order total, sent to couriers that declare a goods value. */
  invoiceValue?: number;
  /** How the customer paid. Providers that cannot represent a method refuse it. */
  paymentMethod?: string;
  /**
   * The pickup instant an ADMIN selected, ISO-8601. Never derived from the clock:
   * a courier pickup is a real-world commitment someone has to keep, so a
   * provider that requires it refuses to book until it is present.
   */
  pickupAtIso?: string;
  items?: ShipmentItem[];
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
  /**
   * True when this courier cannot book without an admin-selected pickup time.
   * Lets the settlement and reconciliation paths skip a shipment that is waiting
   * on a human, instead of attempting a booking that is guaranteed to fail.
   * Optional so existing providers keep their current behaviour.
   */
  readonly requiresPickupSchedule?: boolean;
  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  cancelShipment(providerShipmentId: string): Promise<void>;
  trackShipment(trackingNumber: string): Promise<ShipmentTrackingResult>;
  /** Raw provider status (unmapped) for the ShipmentStatusMapper. */
  trackShipmentRaw(trackingNumber: string): Promise<RawTrackingResult>;
}
