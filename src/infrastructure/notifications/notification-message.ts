import { NotificationChannel } from '@prisma/client';

/** Logical (channel-agnostic) template identifiers. */
export type NotificationTemplate = 'order.transfer' | 'order.cod';

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
    };

/** The ONE contract shared by every provider. Presentation is mapped inside each provider. */
export interface NotificationMessage {
  channel: NotificationChannel;
  template: NotificationTemplate;
  recipient: NotificationRecipient;
  variables: NotificationVariables;
  metadata: NotificationMetadata;
}
