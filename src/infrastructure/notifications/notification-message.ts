import { NotificationChannel } from '@prisma/client';

/** Logical (channel-agnostic) template identifiers. */
export type NotificationTemplate =
  | 'order.transfer'
  | 'order.cod'
  | 'order.shipped'
  | 'order.delivered'
  | 'shipment.status'
  /**
   * INTERNAL operational alert: a new order arrived and needs processing.
   * Addressed to an operator (OPS_NOTIFICATION_WHATSAPP), never to a customer —
   * it is not part of the customer shipment/payment notification family.
   */
  | 'order.new'
  // Admin-composed messages (Customer Communication Center). Same outbox +
  // sender-worker path as automatic notifications.
  | 'manual.order-update'
  | 'manual.shipment-update'
  | 'manual.custom';

/** The manual (admin-composed) template ids, for validation at the API edge. */
export const MANUAL_TEMPLATES = ['manual.order-update', 'manual.shipment-update', 'manual.custom'] as const;
export type ManualTemplate = (typeof MANUAL_TEMPLATES)[number];

export interface NotificationRecipient {
  name: string;
  /** Normalized MSISDN (628…) — set by the builder for WhatsApp/SMS channels. */
  phone?: string;
  email?: string;
}

export interface NotificationMetadata {
  /** NotificationOutbox.id. */
  notificationId: string;
  /** Provider idempotency key (= notificationId today). */
  idempotencyKey: string;
  /** Stable id for provider-side dedup (future). */
  externalRequestId: string;
  /** Resolved by TemplateRegistry — providers do NOT pick a template. */
  providerTemplateId: string;
  attempt?: number;
}

/** Strongly-typed, channel-agnostic template variables (no provider-specific fields). */
export type NotificationVariables =
  | {
      template: 'order.transfer';
      customerName: string;
      orderNumber: string;
      // totalPrice is the final transfer amount (unique code already folded in).
      totalPrice: number;
      uploadToken: string;
      bankName: string;
      bankCode?: string | null;
      accountName: string;
      accountNumber: string;
    }
  | {
      template: 'order.cod';
      customerName: string;
      orderNumber: string;
      totalPrice: number;
      deliveryInfo: string;
    }
  | {
      template: 'order.shipped' | 'order.delivered';
      customerName: string;
      orderNumber: string;
      shippingProvider: string;
      shippingService: string;
      trackingNumber: string;
    }
  | {
      template: 'shipment.status';
      customerName: string;
      orderNumber: string;
      shipmentStatus: string;
      statusLabel: string;
      shippingProvider: string;
      shippingService: string;
      trackingNumber: string;
    }
  | {
      template: 'order.new';
      customerName: string;
      orderNumber: string;
      grandTotal: number;
      /** "GATEWAY · PENDING" — method and payment state in one slot. */
      paymentSummary: string;
      /** "paxel · Paxel Instant" — provider and service in one slot. */
      shippingSummary: string;
      /** Deep link to the admin order-detail page; feeds the template button. */
      adminOrderUrl: string;
    }
  | {
      template: ManualTemplate;
      customerName: string;
      /** Empty for manual.custom messages not tied to an order. */
      orderNumber: string;
      /** Admin-composed message body (fills the single WhatsApp body slot). */
      message: string;
      /** Email subject override (manual.custom only; templates derive their own). */
      subject?: string;
    };

/** The ONE contract shared by every provider. Presentation is mapped inside each provider. */
export interface NotificationMessage {
  channel: NotificationChannel;
  template: NotificationTemplate;
  recipient: NotificationRecipient;
  variables: NotificationVariables;
  metadata: NotificationMetadata;
}
