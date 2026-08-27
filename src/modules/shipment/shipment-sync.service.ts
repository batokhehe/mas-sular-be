import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { NotificationChannel, Prisma, ShipmentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { orderStatusSourcesFor } from '../orders/domain/order-status-transitions';
import type { RawTrackingResult, ShipmentProvider } from './domain/shipment-provider.interface';
import { ShipmentProviderFactory } from './shipment-provider.factory';
import { SHIPMENT_TRACKING_CONFIG, ShipmentTrackingConfig } from './shipment-tracking.config';
import { ShipmentStatusMapper } from './shipment-status.mapper';

/** Fallback when the tracking config is not injected (unit tests). 2 hours. */
const DEFAULT_TRACKING_CACHE_TTL_MS = 7_200_000;

/**
 * Cache identity is the COURIER's identity for the parcel: provider + AWB.
 * Not shipment.id — the same airwaybill is the same question to the courier
 * whatever row asks it, and two providers may legitimately issue the same
 * airwaybill string.
 *
 * Exported (PAXELBOX-33) because the admin edit path must be able to drop the
 * same key it would otherwise read stale. Deriving the format in two places is
 * how a cache silently stops being invalidated, so there is exactly one.
 */
export function trackingCacheKey(provider: string, trackingNumber: string): string {
  return `shipment:tracking:${provider.trim().toLowerCase()}:${trackingNumber}`;
}

// Statuses that can still progress → keep polling. (DELIVERED/FAILED/CANCELLED are
// terminal; UNKNOWN is never persisted so a shipment stays at its last known one.)
const POLLABLE: ShipmentStatus[] = [
  ShipmentStatus.CREATED,
  ShipmentStatus.WAITING_PICKUP,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
];

/**
 * Synchronizes shipment lifecycle with the courier: poll → map (via
 * ShipmentStatusMapper) → update Shipment (only if changed) → update Order →
 * append ShipmentHistory → enqueue a status notification (exactly once per
 * transition). Owns the sync so ShipmentService stays untouched.
 */
@Injectable()
export class ShipmentSyncService {
  private readonly logger = new Logger('ShipmentSyncService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: ShipmentProviderFactory,
    private readonly mapper: ShipmentStatusMapper,
    // Both optional: absent (unit tests, or a build without the cache module)
    // simply means every tick asks the courier, exactly as before.
    @Optional() @Inject(CACHE_MANAGER) private readonly cache?: Cache,
    @Optional() @Inject(SHIPMENT_TRACKING_CONFIG) private readonly config?: ShipmentTrackingConfig,
  ) {}

  /**
   * The courier's last RAW answer for this airwaybill, reused within the TTL.
   *
   * Deliberately wraps ONLY the provider call. Everything downstream — mapping,
   * the status comparison, the CAS, history, the order flip, the notification —
   * runs identically on a hit and a miss, so the cache can change how often the
   * courier is asked but never what the system concludes.
   *
   * Cache faults are swallowed on both sides: the repository's convention is
   * that a cache problem degrades to uncached work rather than failing it.
   * An error from the PROVIDER propagates untouched, so it keeps the existing
   * per-shipment isolation and is never written to the cache.
   */
  private async trackWithCache(
    provider: Pick<ShipmentProvider, 'trackShipmentRaw'>,
    providerName: string,
    trackingNumber: string,
  ): Promise<RawTrackingResult> {
    const key = trackingCacheKey(providerName, trackingNumber);

    try {
      const hit = await this.cache?.get<RawTrackingResult>(key);
      if (hit) return hit;
    } catch {
      // Cache unreachable — fall through and ask the courier.
    }

    const raw = await provider.trackShipmentRaw(trackingNumber);

    try {
      await this.cache?.set(key, raw, this.config?.cacheTtlMs ?? DEFAULT_TRACKING_CACHE_TTL_MS);
    } catch {
      // Never fail a real tracking result because it could not be stored.
    }

    return raw;
  }

  private json(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }

  /** Poll & reconcile up to `limit` non-terminal shipments. Returns rows changed. */
  async syncAll(limit = 50): Promise<number> {
    const shipments = await this.prisma.shipment.findMany({
      where: { status: { in: POLLABLE }, trackingNumber: { not: null } },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            // The service the customer was quoted and paid for. Shipment.service
            // is only a snapshot (and holds the checkout LABEL for orders that
            // were never prepared), so the notification must not read it alone.
            shippingService: true,
            shippingServiceName: true,
            user: { select: { name: true, email: true, phone: true } },
            address: { select: { phone: true } },
          },
        },
      },
      take: limit,
    });

    let changed = 0;
    for (const shipment of shipments) {
      const provider = this.factory.get(shipment.provider);

      // These two skips look alike but mean opposite things, and collapsing
      // them into one `continue` is what hid the second for so long.
      //
      // No airwaybill yet is ordinary: the shipment simply is not trackable,
      // and the reconciliation/booking flow will get to it.
      //
      // An unregistered provider is a DATA DEFECT. Nothing in this build can
      // ever track that courier, so the shipment drops out of tracking
      // permanently — previously without a log line, a history entry, or any
      // operator-visible sign. It is surfaced here, per shipment, so one bad
      // row cannot stop the rest of the batch (the loop's own try/catch does
      // the same for provider errors). Nothing is written to the database:
      // this reports a problem, it does not "fix" the row.
      if (!provider) {
        this.logger.error({
          event: 'shipment.provider_unknown',
          shipmentId: shipment.id,
          orderId: shipment.order?.id,
          orderNumber: shipment.order?.orderNumber,
          provider: shipment.provider,
          trackingNumber: shipment.trackingNumber,
          registeredProviders: this.factory.getAll().map((registered) => registered.name),
        });
        continue;
      }

      if (!shipment.trackingNumber) continue;

      try {
        const raw = await this.trackWithCache(provider, shipment.provider, shipment.trackingNumber);
        const { mapped, known } = this.mapper.map(shipment.provider, raw.providerStatus);

        // Unknown status: already logged by the mapper. Do NOT overwrite a good
        // status with UNKNOWN — leave the shipment as-is and keep polling.
        if (!known) continue;

        // Idempotency: ignore duplicate provider responses — only write on a real change.
        if (mapped === shipment.status) continue;

        await this.applyTransition(shipment, mapped, raw.providerStatus, raw.rawPayload);
        changed += 1;
      } catch (err) {
        this.logger.warn(
          `sync failed for shipment ${shipment.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return changed;
  }

  private async applyTransition(
    shipment: {
      id: string;
      provider: string;
      service: string;
      /** The status this run READ — the CAS below claims the transition on it. */
      status: ShipmentStatus;
      trackingNumber: string | null;
      order: {
        id: string;
        orderNumber: string;
        status: string;
        /** Authoritative service the customer paid for; see the select above. */
        shippingService: string | null;
        shippingServiceName: string | null;
        user: { name: string; email: string; phone: string | null } | null;
        address: { phone: string | null } | null;
      };
    },
    mapped: ShipmentStatus,
    providerStatus: string,
    rawPayload: unknown,
  ): Promise<void> {
    const orderStatus = this.mapper.toOrderStatus(mapped);
    await this.prisma.$transaction(async (tx) => {
      // Claim the transition with a CAS on the status we actually read, the
      // same idiom the order flip below and the booking claim in
      // ShipmentService already use.
      //
      // The in-process `running` guard only serialises ticks within ONE
      // instance. Two instances polling the same shipment would both observe
      // the old status, and everything after this point — the history row and
      // the customer notification — would run twice, contradicting the "notify
      // exactly once per transition" intent below. Losing the CAS means another
      // run already recorded this exact transition, so there is nothing to add.
      const applied = await tx.shipment.updateMany({
        where: { id: shipment.id, status: shipment.status },
        data: { status: mapped, providerPayload: this.json(rawPayload) },
      });
      if (applied.count !== 1) return;

      // Append-only audit of the transition.
      await tx.shipmentHistory.create({
        data: {
          shipmentId: shipment.id,
          providerStatus,
          mappedStatus: mapped,
          changedAt: new Date(),
        },
      });

      // Advance the order only via a legal transition (audit F4): CAS over the
      // allowed source statuses so a CANCELLED/COMPLETED order is never revived by
      // a late courier update. A lost CAS just skips the advance (shipment status
      // and history above are still recorded).
      if (orderStatus && orderStatus !== shipment.order.status) {
        const flip = await tx.order.updateMany({
          where: { id: shipment.order.id, status: { in: orderStatusSourcesFor(orderStatus) } },
          data: { status: orderStatus },
        });
        if (flip.count === 1) {
          await tx.orderEvent.create({
            data: { orderId: shipment.order.id, status: orderStatus, note: `Shipment ${mapped} (${shipment.provider})` },
          });
        }
      }

      // Notify exactly once per transition (only for the notifiable statuses).
      if (this.mapper.shouldNotify(mapped)) {
        const phone = shipment.order.address?.phone ?? shipment.order.user?.phone ?? null;
        await tx.notificationOutbox.create({
          data: {
            channel: NotificationChannel.WHATSAPP,
            recipient: phone ?? '',
            template: 'shipment.status',
            payload: {
              orderId: shipment.order.id,
              orderNumber: shipment.order.orderNumber,
              customerName: shipment.order.user?.name ?? 'Pelanggan',
              customerPhone: phone,
              customerEmail: shipment.order.user?.email ?? null,
              shipmentStatus: mapped,
              statusLabel: this.mapper.label(mapped),
              shippingProvider: shipment.provider,
              shippingService:
                shipment.order.shippingServiceName ??
                shipment.order.shippingService ??
                shipment.service,
              trackingNumber: shipment.trackingNumber ?? '',
            },
            sourceMessageId: randomUUID(),
          },
        });
      }
    });

    this.logger.log({ event: 'shipment.transition', shipmentId: shipment.id, providerStatus, mapped });
  }
}
