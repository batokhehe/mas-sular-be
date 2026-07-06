import { OrderStatus, PaymentStatus, ShipmentStatus } from '@prisma/client';

export type TimelineActor = 'customer' | 'admin' | 'system';

export interface TimelineEntry {
  at: string; // ISO
  type: string; // machine key (icon selection on the client)
  title: string;
  description: string;
  actor: TimelineActor;
}

/** Minimal shape the timeline builder needs (subset of the order + relations). */
export interface TimelineSource {
  createdAt: Date;
  events: Array<{ status: string; note: string | null; createdAt: Date }>;
  payment: {
    createdAt: Date;
    status: string;
    verifiedAt: Date | null;
    transactions: Array<{ status: string; createdAt: Date }>;
  } | null;
  shipment: {
    createdAt: Date;
    history: Array<{ mappedStatus: string; changedAt: Date }>;
  } | null;
  reservations: Array<{ status: string; createdAt: Date; product?: { name: string } | null }>;
}

const SHIPMENT_TITLES: Partial<Record<string, string>> = {
  CREATED: 'Shipment created',
  WAITING_PICKUP: 'Waiting for pickup',
  PICKED_UP: 'Picked up by courier',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  FAILED: 'Shipment failed',
  CANCELLED: 'Shipment cancelled',
};

/**
 * Merge order events, payment lifecycle, inventory reservations, and shipment
 * history into ONE chronologically ordered timeline (oldest → newest). Pure and
 * deterministic so it can be unit-tested in isolation.
 */
export function buildOrderTimeline(src: TimelineSource): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  entries.push({
    at: src.createdAt.toISOString(),
    type: 'order.created',
    title: 'Order created',
    description: 'The customer placed the order.',
    actor: 'customer',
  });

  if (src.payment) {
    entries.push({
      at: src.payment.createdAt.toISOString(),
      type: 'payment.created',
      title: 'Payment created',
      description: 'A payment record was created for the order.',
      actor: 'system',
    });
    // Receipt upload moves the payment to WAITING_VERIFICATION.
    for (const t of src.payment.transactions) {
      if (t.status === PaymentStatus.WAITING_VERIFICATION) {
        entries.push({ at: t.createdAt.toISOString(), type: 'payment.uploaded', title: 'Payment receipt uploaded', description: 'The customer submitted a transfer receipt.', actor: 'customer' });
      }
    }
    if (src.payment.verifiedAt && src.payment.status === PaymentStatus.PAID) {
      entries.push({ at: src.payment.verifiedAt.toISOString(), type: 'payment.verified', title: 'Payment verified', description: 'An admin verified the payment.', actor: 'admin' });
    }
  }

  for (const r of src.reservations) {
    entries.push({
      at: r.createdAt.toISOString(),
      type: 'inventory.reserved',
      title: 'Inventory reserved',
      description: r.product?.name ? `Stock reserved for ${r.product.name}.` : 'Stock reserved for an item.',
      actor: 'system',
    });
  }

  if (src.shipment) {
    for (const h of src.shipment.history) {
      entries.push({
        at: h.changedAt.toISOString(),
        type: `shipment.${h.mappedStatus.toLowerCase()}`,
        title: SHIPMENT_TITLES[h.mappedStatus] ?? `Shipment ${h.mappedStatus}`,
        description: `Courier reported status: ${h.mappedStatus}.`,
        actor: 'system',
      });
    }
  }

  // Order lifecycle events (cancelled / refunded / status changes) from OrderEvent.
  for (const e of src.events) {
    if (e.status === OrderStatus.CANCELLED) {
      entries.push({ at: e.createdAt.toISOString(), type: 'order.cancelled', title: 'Order cancelled', description: e.note ?? 'The order was cancelled.', actor: 'admin' });
    }
  }

  return entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

/** Shape needed to decide which quick actions are valid. */
export interface ActionSource {
  status: string;
  payment: { status: string; manualReceiptUrl: string | null } | null;
  shipment: { status: string; trackingNumber: string | null; trackingUrl: string | null } | null;
}

export interface AvailableActions {
  verifyPayment: boolean;
  rejectPayment: boolean;
  retryShipment: boolean;
  cancelOrder: boolean;
  downloadReceipt: boolean;
  openTracking: boolean;
}

const PENDING_PAYMENT: string[] = [PaymentStatus.PENDING, PaymentStatus.WAITING_VERIFICATION];
const CANCELLABLE: string[] = [OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.PACKING];

/**
 * Compute which quick actions apply to the order's CURRENT state, so the UI only
 * offers valid ones. Pure (no I/O) → unit-testable. These map to existing
 * endpoints (verify/reject/retry/cancel); no new write flow is introduced.
 */
export function computeAvailableActions(order: ActionSource): AvailableActions {
  const payment = order.payment;
  const shipment = order.shipment;
  const paymentPending = payment ? PENDING_PAYMENT.includes(payment.status) : false;
  const shipmentRecoverable =
    !!shipment &&
    (shipment.status === ShipmentStatus.FAILED ||
      ((shipment.status === ShipmentStatus.RATE_SELECTED || shipment.status === ShipmentStatus.PENDING) && !shipment.trackingNumber));

  return {
    verifyPayment: paymentPending,
    rejectPayment: paymentPending,
    retryShipment: shipmentRecoverable,
    cancelOrder: CANCELLABLE.includes(order.status),
    downloadReceipt: !!payment?.manualReceiptUrl,
    openTracking: !!(shipment?.trackingNumber || shipment?.trackingUrl),
  };
}
