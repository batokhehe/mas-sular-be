import { Module, OnModuleInit } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { PaymentAccountsModule } from '../../modules/payment-accounts/payment-accounts.module';
import { PaymentAccountService } from '../../modules/payment-accounts/payment-account.service';
import { ACTIVE_PAYMENT_ACCOUNT_SOURCE } from './active-payment-account.source';
import { EmailNotificationProvider } from './email-notification.provider';
import { NOTIFICATION_SENDER_CONFIG, loadNotificationSenderConfig } from './notification.config';
import { NotificationMessageBuilder } from './notification-message.builder';
import { NotificationMetrics } from './notification.metrics';
import { NotificationProviderFactory } from './notification-provider.factory';
import { NotificationSenderWorker } from './notification-sender.worker';
import { QONTAK_CONFIG, assertQontakConfigured, loadQontakConfig } from './qontak.config';
import { QontakWhatsAppProvider } from './qontak-whatsapp.provider';
import { TemplateRegistry } from './template-registry';
import { TemplateRenderer } from './template-renderer';

@Module({
  imports: [PaymentAccountsModule],
  providers: [
    { provide: NOTIFICATION_SENDER_CONFIG, useFactory: () => loadNotificationSenderConfig() },
    { provide: QONTAK_CONFIG, useFactory: () => loadQontakConfig() },
    // Narrow port: the builder depends only on getActiveAccount(), implemented by the service.
    { provide: ACTIVE_PAYMENT_ACCOUNT_SOURCE, useExisting: PaymentAccountService },
    NotificationMetrics,
    TemplateRenderer,
    TemplateRegistry,
    EmailNotificationProvider,
    QontakWhatsAppProvider,
    NotificationProviderFactory,
    NotificationMessageBuilder,
    NotificationSenderWorker,
  ],
  exports: [NotificationMetrics],
})
export class NotificationsModule implements OnModuleInit {
  constructor(private readonly registry: TemplateRegistry) {}

  /**
   * Fail-fast: when the sender is enabled and WhatsApp is routable, every required
   * (channel, template) pair must resolve and Qontak credentials must be present.
   */
  onModuleInit(): void {
    if (process.env.NOTIFICATION_SENDER_ENABLED !== 'true') return;
    const mode = process.env.NOTIFICATION_PROVIDER ?? 'multi';
    if (mode === 'multi' || mode === 'qontak') {
      assertQontakConfigured(loadQontakConfig());
      this.registry.assertResolvable([
        { channel: NotificationChannel.WHATSAPP, template: 'order.transfer' },
        { channel: NotificationChannel.WHATSAPP, template: 'order.cod' },
      ]);
    }
  }
}
