import { Injectable } from '@nestjs/common';
import { PermanentSendError } from './notification-provider';

export interface RenderedMessage {
  subject: string;
  body: string;
}

/**
 * Renders a template id + payload snapshot into channel content. Templates live
 * in code (versionable without a data migration). An unknown template is a
 * permanent error (never retried).
 */
@Injectable()
export class TemplateRenderer {
  render(template: string, payload: Record<string, unknown>): RenderedMessage {
    switch (template) {
      case 'order.received':
        return {
          subject: `Order ${payload.orderNumber ?? ''} received`,
          body:
            `Hi ${payload.customerName ?? 'there'}, we have received your order ` +
            `${payload.orderNumber ?? ''} (total ${payload.totalPrice ?? ''}). Thank you!` +
            // Non-COD orders carry an upload link so the customer can submit their receipt.
            (payload.uploadUrl ? ` To complete payment, upload your receipt here: ${payload.uploadUrl}` : ''),
        };
      case 'payment.approved':
        return {
          subject: `Payment received for order ${payload.orderNumber ?? ''}`,
          body:
            `Hi ${payload.customerName ?? 'there'}, we have verified your payment for order ` +
            `${payload.orderNumber ?? ''}. Your order is now being processed.`,
        };
      case 'payment.rejected':
        return {
          subject: `Payment issue for order ${payload.orderNumber ?? ''}`,
          body:
            `Hi ${payload.customerName ?? 'there'}, we could not verify your payment for order ` +
            `${payload.orderNumber ?? ''}. Please contact us or try paying again.`,
        };
      case 'payment.receipt_uploaded':
        // Admin-facing: a customer submitted proof that needs verification.
        return {
          subject: `New payment proof for order ${payload.orderNumber ?? ''}`,
          body:
            `${payload.customerName ?? 'A customer'} uploaded a payment receipt for order ` +
            `${payload.orderNumber ?? ''}. Please review and verify it in the admin dashboard.`,
        };
      case 'payment.expired':
        return {
          subject: `Order ${payload.orderNumber ?? ''} payment expired`,
          body:
            `Hi ${payload.customerName ?? 'there'}, the payment window for order ${payload.orderNumber ?? ''} ` +
            `has expired and the order was cancelled. You are welcome to place a new order.`,
        };
      case 'payment.reminder': {
        const tone = payload.stage === 'second' ? 'a final reminder' : 'a friendly reminder';
        return {
          subject: `Reminder: complete payment for order ${payload.orderNumber ?? ''}`,
          body:
            `Hi ${payload.customerName ?? 'there'}, ${tone} to complete payment for order ` +
            `${payload.orderNumber ?? ''} (${payload.paymentMethod ?? ''}, total ${payload.amount ?? ''}). ` +
            `Upload your receipt here: ${payload.uploadUrl ?? ''}`,
        };
      }
      default:
        throw new PermanentSendError(`Unknown notification template: ${template}`);
    }
  }
}
