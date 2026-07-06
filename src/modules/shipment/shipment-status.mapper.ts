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
const PAXEL: Record<string, ShipmentStatus> = {
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
