import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, ShipmentStatus } from '@prisma/client';

export interface MappedStatus {
  mapped: ShipmentStatus;
  known: boolean;
}

/** Normalize a raw provider status: uppercase, collapse separators to `_`. */
function norm(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

// Provider-specific status dictionaries (keyed by normalized provider status).
/**
 * Paxel's real status vocabulary, from the webhook examples in the Paxel
 * eCommerce API Postman collection. Each mapping below is backed by the note
 * text Paxel ships with that status; codes whose meaning the collection does
 * NOT establish are deliberately absent so they fall through to UNKNOWN rather
 * than being guessed from the acronym:
 *
 *   HAPH, FAILED3PL, ONHOLD3PL, ODL, ODLXL, POLXL
 *
 * The locker states (ODL/ODLXL/POLXL) are the tempting ones — "shipment on
 * destination locker" could plausibly be OUT_FOR_DELIVERY or DELIVERED, and
 * guessing wrong would either notify a customer early or mark an undelivered
 * parcel as done. UNKNOWN is the honest answer until Paxel documents them.
 *
 * The generic keys are kept alongside: they cost nothing and cover a provider
 * that starts returning plain words.
 */
const PAXEL: Record<string, ShipmentStatus> = {
  // --- documented Paxel codes ---
  CONFIRMED: ShipmentStatus.CREATED,
  RTP: ShipmentStatus.WAITING_PICKUP, // driver on the way to pickup
  COL: ShipmentStatus.WAITING_PICKUP, // driver arrived at pickup location
  PAPV: ShipmentStatus.PICKED_UP, // "your shipment received by <driver>"
  POL: ShipmentStatus.IN_TRANSIT, // "shipment in transit"
  POD: ShipmentStatus.OUT_FOR_DELIVERY, // "on the way to destination"
  COD: ShipmentStatus.OUT_FOR_DELIVERY, // "<driver> on destination"
  PDO: ShipmentStatus.DELIVERED, // "has been delivered by <driver>"
  PRJL: ShipmentStatus.FAILED, // rejected, shipment not ready
  RAP: ShipmentStatus.FAILED, // failed pickup, sender uncontactable
  UNDLM: ShipmentStatus.FAILED, // undelivered, address not found
  RTN: ShipmentStatus.FAILED, // returning to sender (no RETURNED in the enum)
  // Confirmed against Paxel staging, not inferred from the acronym: POST
  // /shipments/:awb/cancel returned 200 echoing our cancellation_reason, after
  // which GET /shipments/:awb reported latest_status "CCS" carrying that same
  // reason. Until this mapping existed, CCS fell through to UNKNOWN, which the
  // sync service never persists - so a shipment cancelled at Paxel stayed
  // CREATED in our database forever.
  CCS: ShipmentStatus.CANCELLED,

  // --- generic fallbacks, retained ---
  BOOKED: ShipmentStatus.CREATED,
  CREATED: ShipmentStatus.CREATED,
  WAITING_PICKUP: ShipmentStatus.WAITING_PICKUP,
  PICKED_UP: ShipmentStatus.PICKED_UP,
  IN_TRANSIT: ShipmentStatus.IN_TRANSIT,
  OUT_FOR_DELIVERY: ShipmentStatus.OUT_FOR_DELIVERY,
  DELIVERED: ShipmentStatus.DELIVERED,
  FAILED: ShipmentStatus.FAILED,
  CANCELLED: ShipmentStatus.CANCELLED,
  CANCELED: ShipmentStatus.CANCELLED,
};

const JNE: Record<string, ShipmentStatus> = {
  SUCCESS: ShipmentStatus.CREATED,
  MANIFESTED: ShipmentStatus.CREATED,
  RECEIVED_AT_ORIGIN: ShipmentStatus.CREATED,
  WAITING_PICKUP: ShipmentStatus.WAITING_PICKUP,
  PICKED_UP: ShipmentStatus.PICKED_UP,
  RECEIVED_AT_WAREHOUSE: ShipmentStatus.PICKED_UP,
  ON_PROCESS: ShipmentStatus.IN_TRANSIT,
  IN_TRANSIT: ShipmentStatus.IN_TRANSIT,
  TRANSIT: ShipmentStatus.IN_TRANSIT,
  RECEIVED_AT_SORTING: ShipmentStatus.IN_TRANSIT,
  WITH_DELIVERY_COURIER: ShipmentStatus.OUT_FOR_DELIVERY,
  ON_DELIVERY: ShipmentStatus.OUT_FOR_DELIVERY,
  OUT_FOR_DELIVERY: ShipmentStatus.OUT_FOR_DELIVERY,
  DELIVERED: ShipmentStatus.DELIVERED,
  POD: ShipmentStatus.DELIVERED,
  CANCELLED: ShipmentStatus.CANCELLED,
  FAILED: ShipmentStatus.FAILED,
  RETURNED: ShipmentStatus.FAILED,
  UNDELIVERED: ShipmentStatus.FAILED,
};

const DICTIONARIES: Record<string, Record<string, ShipmentStatus>> = { paxel: PAXEL, jne: JNE };

/**
 * Pure provider-status lookup, exported so adapters do not keep a second copy of
 * the vocabulary. A provider that maintained its own switch drifted from this
 * dictionary and silently answered UNKNOWN for statuses that were mapped here.
 * Returns undefined when the status is not recognised; the caller decides what
 * that means (the Nest service logs it, an adapter falls back to UNKNOWN).
 */
export function lookupProviderStatus(provider: string, providerStatus: string): ShipmentStatus | undefined {
  return DICTIONARIES[provider.toLowerCase()]?.[norm(providerStatus)];
}

// Which mapped statuses trigger a customer notification (one per transition).
const NOTIFY_STATUSES = new Set<ShipmentStatus>([
  ShipmentStatus.CREATED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.CANCELLED,
  ShipmentStatus.FAILED,
]);

// Terminal shipment states — polling stops here.
export const TERMINAL_SHIPMENT_STATUSES = new Set<ShipmentStatus>([
  ShipmentStatus.DELIVERED,
  ShipmentStatus.FAILED,
  ShipmentStatus.CANCELLED,
]);

const STATUS_LABEL: Partial<Record<ShipmentStatus, string>> = {
  [ShipmentStatus.CREATED]: 'telah dibuat',
  [ShipmentStatus.WAITING_PICKUP]: 'menunggu penjemputan kurir',
  [ShipmentStatus.PICKED_UP]: 'telah dijemput kurir',
  [ShipmentStatus.IN_TRANSIT]: 'sedang dalam perjalanan',
  [ShipmentStatus.OUT_FOR_DELIVERY]: 'sedang menuju alamat Anda',
  [ShipmentStatus.DELIVERED]: 'telah sampai di tujuan',
  [ShipmentStatus.CANCELLED]: 'dibatalkan',
  [ShipmentStatus.FAILED]: 'gagal dikirim',
};

/**
 * Maps provider-specific tracking statuses into internal ShipmentStatus, plus the
 * derived order status and notification metadata. Unknown provider statuses map to
 * UNKNOWN and are logged (never silently swallowed).
 */
@Injectable()
export class ShipmentStatusMapper {
  private readonly logger = new Logger('ShipmentStatusMapper');

  map(provider: string, providerStatus: string): MappedStatus {
    const dict = DICTIONARIES[provider.toLowerCase()];
    const mapped = dict?.[norm(providerStatus)];
    if (!mapped) {
      this.logger.warn(
        `Unknown shipment status from provider '${provider}': '${providerStatus}' → UNKNOWN`,
      );
      return { mapped: ShipmentStatus.UNKNOWN, known: false };
    }
    return { mapped, known: true };
  }

  /** Order status implied by a shipment status (null = leave the order unchanged). */
  toOrderStatus(status: ShipmentStatus): OrderStatus | null {
    switch (status) {
      case ShipmentStatus.CREATED:
      case ShipmentStatus.WAITING_PICKUP:
        return OrderStatus.SHIPPED;
      case ShipmentStatus.PICKED_UP:
      case ShipmentStatus.IN_TRANSIT:
      case ShipmentStatus.OUT_FOR_DELIVERY:
        return OrderStatus.DELIVERING;
      case ShipmentStatus.DELIVERED:
        return OrderStatus.DELIVERED;
      case ShipmentStatus.CANCELLED:
        return OrderStatus.CANCELLED;
      default:
        return null;
    }
  }

  shouldNotify(status: ShipmentStatus): boolean {
    return NOTIFY_STATUSES.has(status);
  }

  isTerminal(status: ShipmentStatus): boolean {
    return TERMINAL_SHIPMENT_STATUSES.has(status);
  }

  label(status: ShipmentStatus): string {
    return STATUS_LABEL[status] ?? status;
  }
}
