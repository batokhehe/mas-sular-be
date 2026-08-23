import { Prisma } from '@prisma/client';

/**
 * Typed accessors for `Shipment.metadata`.
 *
 * The admin-selected pickup time lives here rather than in a new column: it is
 * provider-specific (only Paxel requires it) and adding a column for one
 * courier's field would push provider detail into the shared schema. Keeping
 * the shape in one module is what stops `metadata` from degenerating into
 * ad-hoc string keys spread across services.
 *
 * `pickupDatetime` is stored as ISO-8601 — the exact instant the admin chose.
 * The provider formats it for its own wire contract; nothing else reinterprets
 * it, and it is never derived from the clock.
 */

export interface PaxelShipmentMetadata {
  /** ISO-8601. The admin's choice, verbatim. */
  pickupDatetime?: string;
}

export interface ShipmentMetadata {
  paxel?: PaxelShipmentMetadata;
  /** Failure diagnostics written by createForOrderSafe. */
  error?: string;
  failedAt?: string;
}

/** Narrow the loosely-typed Json column without throwing on legacy shapes. */
export function readShipmentMetadata(value: Prisma.JsonValue | null | undefined): ShipmentMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as ShipmentMetadata;
}

/** The admin-selected pickup instant, or undefined when none has been chosen yet. */
export function readPickupDatetime(value: Prisma.JsonValue | null | undefined): string | undefined {
  const pickup = readShipmentMetadata(value).paxel?.pickupDatetime;
  return pickup && pickup.trim() ? pickup : undefined;
}

/**
 * Merge a pickup time into existing metadata. Merging rather than replacing so a
 * later booking attempt does not erase the failure diagnostics from an earlier
 * one, which is the only record of why a shipment is stuck.
 */
export function withPickupDatetime(
  existing: Prisma.JsonValue | null | undefined,
  pickupDatetimeIso: string,
): Prisma.InputJsonValue {
  const current = readShipmentMetadata(existing);
  return {
    ...current,
    paxel: { ...(current.paxel ?? {}), pickupDatetime: pickupDatetimeIso },
  } as Prisma.InputJsonValue;
}
