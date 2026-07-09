import { Inject, Injectable } from '@nestjs/common';
import { NotificationChannel, NotificationOutbox } from '@prisma/client';
import { ConfigurationError } from '../../common/errors/configuration.error';
import { normalizePhoneNumber } from '../../common/utils/phone.util';
import { ACTIVE_PAYMENT_ACCOUNT_SOURCE, ActivePaymentAccountSource } from './active-payment-account.source';
import {
  NotificationMessage,
  NotificationRecipient,
  NotificationTemplate,
  NotificationVariables,
} from './notification-message';
import { TemplateRegistry } from './template-registry';

/**
 * Turns a persisted NotificationOutbox row into a channel-agnostic
 * NotificationMessage: normalizes the phone, loads the active payment account
 * (transfer only), and resolves the provider template id via the registry.
 * This is the ONLY place that knows business detail — providers stay transport-only.
 */
@Injectable()
export class NotificationMessageBuilder {
  constructor(
    @Inject(ACTIVE_PAYMENT_ACCOUNT_SOURCE) private readonly accounts: ActivePaymentAccountSource,
    private readonly registry: TemplateRegistry,
  ) {}

  async build(row: NotificationOutbox): Promise<NotificationMessage> {
    const channel = row.channel;
    const template = row.template as NotificationTemplate;
    const p = (row.payload as Record<string, unknown> | null) ?? {};

    const customerName = String(p.customerName ?? 'Pelanggan');
    const orderNumber = String(p.orderNumber ?? '');
    const totalPrice = Number(p.totalPrice ?? 0);

    const recipient: NotificationRecipient = { name: customerName };
    // Always carry email when available so the email provider (NOTIFICATION_PROVIDER=email
    // failover) can deliver even for WhatsApp-origin rows.
    const email = (p.customerEmail as string | undefined) ?? (channel === NotificationChannel.EMAIL ? row.recipient : undefined);
    if (email) recipient.email = email;
    if (channel === NotificationChannel.WHATSAPP) {
      recipient.phone = normalizePhoneNumber((p.customerPhone as string | undefined) ?? row.recipient);
    }

    let variables: NotificationVariables;
    if (template === 'shipment.status') {
      variables = {
        template: 'shipment.status',
        customerName,
        orderNumber,
        shipmentStatus: String(p.shipmentStatus ?? ''),
        statusLabel: String(p.statusLabel ?? ''),
        shippingProvider: String(p.shippingProvider ?? ''),
        shippingService: String(p.shippingService ?? ''),
        trackingNumber: String(p.trackingNumber ?? ''),
      };
    } else if (template === 'order.shipped' || template === 'order.delivered') {
      variables = {
        template,
        customerName,
        orderNumber,
        shippingProvider: String(p.shippingProvider ?? ''),
        shippingService: String(p.shippingService ?? ''),
        trackingNumber: String(p.trackingNumber ?? ''),
      };
    } else if (template === 'order.transfer') {
      const account = await this.accounts.getActiveAccount(); // → ConfigurationError if none active
      const uploadToken = String(p.uploadToken ?? '');
      if (!uploadToken) {
        throw new ConfigurationError(`transfer notification ${row.id} is missing uploadToken`);
      }
      // The unique code is already folded into totalPrice (the final transfer amount),
      // so the customer-facing message shows only the total — no separate code line.
      variables = {
        template: 'order.transfer',
        customerName,
        orderNumber,
        totalPrice,
        uploadToken,
        bankName: account.bankName,
        bankCode: account.bankCode,
        accountName: account.accountName,
        accountNumber: account.accountNumber,
      };
    } else if (template === 'manual.order-update' || template === 'manual.shipment-update' || template === 'manual.custom') {
      // Admin-composed message (Customer Communication Center) — free text only,
      // no business lookups.
      variables = {
        template,
        customerName,
        orderNumber,
        message: String(p.message ?? ''),
        ...(p.subject ? { subject: String(p.subject) } : {}),
      };
    } else {
      variables = {
        template: 'order.cod',
        customerName,
        orderNumber,
        totalPrice,
        deliveryInfo: String(p.deliveryInfo ?? 'Pembayaran dilakukan saat pesanan tiba (COD).'),
      };
    }

    const descriptor = this.registry.resolve(channel, template);
    return {
      channel,
      template,
      recipient,
      variables,
      metadata: {
        notificationId: row.id,
        idempotencyKey: row.id,
        externalRequestId: `ord:${orderNumber}:${row.id}`,
        providerTemplateId: descriptor.providerTemplateId,
        attempt: row.attempts,
      },
    };
  }
}
