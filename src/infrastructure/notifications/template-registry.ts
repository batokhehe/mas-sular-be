import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { ConfigurationError } from '../../common/errors/configuration.error';
import { loadQontakConfig, QontakConfig } from './qontak.config';
import { NotificationTemplate } from './notification-message';

/** One Qontak body parameter: which variable feeds which template slot. */
export interface QontakBodyParam {
  key: string; // "1".."6"
  valueName: string; // e.g. "customer_name"
  source: string; // variable key on NotificationVariables
  format?: 'currency';
}

/**
 * Descriptor-based template mapping. Resolving (channel, logicalTemplate) yields
 * the provider template id + (for WhatsApp) the parameter/button layout, so the
 * provider stays generic: adding a template is a registry change, not a code change.
 */
export interface ProviderTemplateDescriptor {
  /** Qontak message_template_id, or the renderer template key for EMAIL. */
  providerTemplateId: string;
  /** WhatsApp body parameter layout (undefined for non-templated channels). */
  body?: QontakBodyParam[];
  /** Include the dynamic-URL button fed by variables.uploadToken. */
  button?: boolean;
}

@Injectable()
export class TemplateRegistry {
  private readonly map = new Map<string, ProviderTemplateDescriptor>();

  constructor() {
    const qontak: QontakConfig = loadQontakConfig();
    // EMAIL → renderer template key (EmailProvider renders text from variables).
    this.register(NotificationChannel.EMAIL, 'order.transfer', { providerTemplateId: 'order.transfer' });
    this.register(NotificationChannel.EMAIL, 'order.cod', { providerTemplateId: 'order.cod' });

    // WHATSAPP → Qontak template ids + parameter layout.
    this.register(NotificationChannel.WHATSAPP, 'order.transfer', {
      providerTemplateId: qontak.orderTemplateId ?? '',
      body: [
        { key: '1', valueName: 'customer_name', source: 'customerName' },
        { key: '2', valueName: 'order_no', source: 'orderNumber' },
        { key: '3', valueName: 'price', source: 'totalPrice', format: 'currency' },
        { key: '4', valueName: 'bank_name', source: 'bankName' },
        { key: '5', valueName: 'account_name', source: 'accountName' },
        { key: '6', valueName: 'account_number', source: 'accountNumber' },
      ],
      button: true,
    });
    this.register(NotificationChannel.WHATSAPP, 'order.cod', {
      providerTemplateId: qontak.codTemplateId ?? '',
      body: [
        { key: '1', valueName: 'customer_name', source: 'customerName' },
        { key: '2', valueName: 'order_no', source: 'orderNumber' },
        { key: '3', valueName: 'price', source: 'totalPrice', format: 'currency' },
        { key: '4', valueName: 'delivery_info', source: 'deliveryInfo' },
      ],
      button: false,
    });
  }

  private key(channel: NotificationChannel, template: NotificationTemplate): string {
    return `${channel}:${template}`;
  }

  private register(channel: NotificationChannel, template: NotificationTemplate, d: ProviderTemplateDescriptor): void {
    this.map.set(this.key(channel, template), d);
  }

  /** Resolve a descriptor; throws ConfigurationError when the pair is unknown/unconfigured. */
  resolve(channel: NotificationChannel, template: NotificationTemplate): ProviderTemplateDescriptor {
    const d = this.map.get(this.key(channel, template));
    if (!d) {
      throw new ConfigurationError(`No template registered for ${channel}/${template}`);
    }
    if (!d.providerTemplateId) {
      throw new ConfigurationError(`Provider template id missing for ${channel}/${template}`);
    }
    return d;
  }

  /** Boot-time check: every required (channel, template) pair resolves. */
  assertResolvable(pairs: Array<{ channel: NotificationChannel; template: NotificationTemplate }>): void {
    for (const p of pairs) this.resolve(p.channel, p.template);
  }
}
