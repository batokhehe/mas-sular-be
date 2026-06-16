import { Module } from '@nestjs/common';
import { EmailNotificationProvider } from './email-notification.provider';
import { NOTIFICATION_SENDER_CONFIG, loadNotificationSenderConfig } from './notification.config';
import { NotificationMetrics } from './notification.metrics';
import { NotificationSenderWorker } from './notification-sender.worker';
import { TemplateRenderer } from './template-renderer';

@Module({
  providers: [
    { provide: NOTIFICATION_SENDER_CONFIG, useFactory: () => loadNotificationSenderConfig() },
    NotificationMetrics,
    EmailNotificationProvider,
    TemplateRenderer,
    NotificationSenderWorker,
  ],
  exports: [NotificationMetrics],
})
export class NotificationsModule {}
