import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationChannel, OrderStatus, Prisma, ShipmentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { CreateShipmentInput } from './domain/shipment-provider.interface';
import { ShipmentProviderFactory } from './shipment-provider.factory';

const NON_TERMINAL_TRACKING: ShipmentStatus[] = [
  ShipmentStatus.CREATED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
];

export interface ShipmentOutcome {
  ok: boolean;
  status: ShipmentStatus;
  trackingNumber?: string | null;
  error?: string;
}

/**
 * Creates & tracks courier shipments AFTER payment is PAID (never during checkout).
 * Uses the ShipmentProviderFactory to pick the courier that was quoted on the order.
 */
@Injectable()
export class ShipmentService {
  private readonly logger = new Logger('ShipmentService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: ShipmentProviderFactory,
  ) {}

  private toNum(v: unknown): number | undefined {
    return v === null || v === undefined ? undefined : Number(v);
  }

  private json(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }

  /**
   * Book the shipment for an order with the courier. Idempotent: a shipment that
   * already carries a tracking number is returned unchanged. Throws on failure
   * (callers that must not surface errors use createForOrderSafe).
   */
  async createForOrder(orderId: string): Promise<ShipmentOutcome> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        shipment: true,
        address: true,
        user: { select: { name: true, email: true, phone: true } },
        items: { select: { quantity: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    const shipment = order.shipment;
    if (!shipment) throw new NotFoundException('Order has no shipment row');

    // Idempotent: already booked.
    if (shipment.trackingNumber) {
      return { ok: true, status: shipment.status, trackingNumber: shipment.trackingNumber };
    }

    const providerName = order.shippingProvider ?? shipment.provider;
    const provider = this.factory.get(providerName);
    if (!provider) {
      throw new Error(`No shipment provider registered for '${providerName}'`);
    }

    // Origin = the outlet allocated at checkout (order.outletId); fall back to the
    // active outlet for legacy orders that predate multi-outlet allocation.
    const outlet = order.outletId
      ? await this.prisma.outlet.findUnique({ where: { id: order.outletId } })
      : await this.prisma.outlet.findFirst({ where: { isActive: true } });
    if (!outlet || !outlet.postalCode) {
      throw new Error('No active outlet with a postal code configured');
    }
    if (!order.address?.postalCode) {
      throw new Error('Order address is missing a postal code');
    }

    const totalItems = order.items.reduce((sum, i) => sum + i.quantity, 0);
    const input: CreateShipmentInput = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      service: order.shippingService ?? shipment.service,
      serviceName: order.shippingServiceName ?? undefined,
      weightGram: Math.max(1, totalItems) * 500,
      origin: {
        name: outlet.name,
        postalCode: outlet.postalCode,
        latitude: this.toNum(outlet.latitude),
        longitude: this.toNum(outlet.longitude),
      },
      destination: {
        name: order.address.recipientName,
        phone: order.address.phone,
        addressDetail: order.address.addressDetail ?? order.address.fullAddress,
        postalCode: order.address.postalCode,
        latitude: this.toNum(order.address.latitude),
        longitude: this.toNum(order.address.longitude),
      },
    };

    const result = await provider.createShipment(input);

    await this.prisma.$transaction(async (tx) => {
      await tx.shipment.update({
        where: { id: shipment.id },
        data: {
          status: result.status,
          trackingNumber: result.trackingNumber,
          providerShipmentId: result.providerShipmentId,
          providerPayload: this.json(result.rawPayload),
        },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.SHIPPED,
          trackingNumber: result.trackingNumber,
          events: { create: { status: OrderStatus.SHIPPED, note: `Shipment created (${providerName})` } },
        },
      });
      await this.enqueueWhatsApp(tx, 'order.shipped', order, {
        provider: providerName,
        service: order.shippingServiceName ?? order.shippingService ?? shipment.service,
        tracking: result.trackingNumber,
      });
    });

    this.logger.log({ event: 'shipment.created', orderId, provider: providerName, tracking: result.trackingNumber });
    return { ok: true, status: result.status, trackingNumber: result.trackingNumber };
  }

  /** Never-throwing variant used by the payment-verify flow and the retry endpoint.
   *  On failure the shipment is marked FAILED (Retry becomes available). */
  async createForOrderSafe(orderId: string): Promise<ShipmentOutcome> {
    try {
      return await this.createForOrder(orderId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ event: 'shipment.create_failed', orderId, error: message });
      await this.prisma.shipment
        .updateMany({
          where: { orderId, trackingNumber: null },
          data: { status: ShipmentStatus.FAILED, metadata: this.json({ error: message, failedAt: new Date().toISOString() }) },
        })
        .catch(() => undefined);
      return { ok: false, status: ShipmentStatus.FAILED, error: message };
    }
  }

  /** Admin retry: re-attempt creation for a FAILED (or not-yet-created) shipment. */
  async retry(orderId: string): Promise<ShipmentOutcome> {
    return this.createForOrderSafe(orderId);
  }

  /**
   * Background poll: advance non-terminal shipments by querying the courier, update
   * shipment + order status, and notify on delivery. Returns the number updated.
   */
  async pollAndUpdate(limit = 50): Promise<number> {
    const shipments = await this.prisma.shipment.findMany({
      where: { status: { in: NON_TERMINAL_TRACKING }, trackingNumber: { not: null } },
      include: {
        order: { include: { user: { select: { name: true, email: true, phone: true } }, address: { select: { phone: true } } } },
      },
      take: limit,
    });

    let updated = 0;
    for (const shipment of shipments) {
      const provider = this.factory.get(shipment.provider);
      if (!provider || !shipment.trackingNumber) continue;
      try {
        const result = await provider.trackShipment(shipment.trackingNumber);
        if (result.status === shipment.status) continue;

        await this.prisma.$transaction(async (tx) => {
          await tx.shipment.update({
            where: { id: shipment.id },
            data: { status: result.status, providerPayload: this.json(result.rawPayload) },
          });
          if (result.status === ShipmentStatus.DELIVERED) {
            await tx.order.update({
              where: { id: shipment.orderId },
              data: {
                status: OrderStatus.DELIVERED,
                events: { create: { status: OrderStatus.DELIVERED, note: 'Delivered (courier tracking)' } },
              },
            });
            await this.enqueueWhatsApp(tx, 'order.delivered', shipment.order, {
              provider: shipment.provider,
              service: shipment.service,
              tracking: shipment.trackingNumber ?? '',
            });
          }
        });
        updated += 1;
      } catch (err) {
        this.logger.warn({ event: 'shipment.track_failed', shipmentId: shipment.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return updated;
  }

  /** Enqueue a WhatsApp notification row for the durable sender worker to deliver. */
  private async enqueueWhatsApp(
    tx: Prisma.TransactionClient,
    template: 'order.shipped' | 'order.delivered',
    order: {
      id: string;
      orderNumber: string;
      user?: { name: string; email: string; phone: string | null } | null;
      address?: { phone: string | null } | null;
    },
    vars: { provider: string; service: string; tracking: string },
  ): Promise<void> {
    const phone = order.address?.phone ?? order.user?.phone ?? null;
    await tx.notificationOutbox.create({
      data: {
        channel: NotificationChannel.WHATSAPP,
        recipient: phone ?? '',
        template,
        payload: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerName: order.user?.name ?? 'Pelanggan',
          customerPhone: phone,
          customerEmail: order.user?.email ?? null,
          shippingProvider: vars.provider,
          shippingService: vars.service,
          trackingNumber: vars.tracking,
        },
        sourceMessageId: randomUUID(),
      },
    });
  }
}
