import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, Prisma, ShipmentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { ShipmentProviderFactory } from './shipment-provider.factory';
import { ShipmentStatusMapper } from './shipment-status.mapper';

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
  ) {}

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
      if (!provider || !shipment.trackingNumber) continue;

      try {
        const raw = await provider.trackShipmentRaw(shipment.trackingNumber);
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
      trackingNumber: string | null;
      order: {
        id: string;
        orderNumber: string;
        status: string;
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
      await tx.shipment.update({
        where: { id: shipment.id },
        data: { status: mapped, providerPayload: this.json(rawPayload) },
      });

      // Append-only audit of the transition.
      await tx.shipmentHistory.create({
        data: {
          shipmentId: shipment.id,
          providerStatus,
          mappedStatus: mapped,
          changedAt: new Date(),
        },
      });

      // Advance the order only when the mapping yields a status and it differs.
      if (orderStatus && orderStatus !== shipment.order.status) {
        await tx.order.update({
          where: { id: shipment.order.id },
          data: {
            status: orderStatus,
            events: { create: { status: orderStatus, note: `Shipment ${mapped} (${shipment.provider})` } },
          },
        });
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
              shippingService: shipment.service,
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
