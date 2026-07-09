import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { CONSUMERS_CONFIG, loadConsumersConfig } from '../consumers/consumers.config';
import { AdminNotificationRepository } from './admin-notification.repository';
import { AdminNotificationDispatcher } from './admin-notification.dispatcher';
import { AdminNotificationConsumer } from './admin-notification.consumer';
import { AdminNotificationMetrics } from './admin-notification.metrics';
import { NotificationRetentionWorker } from './notification-retention.worker';
import { FirebasePushChannel } from './push.channel';
import { SseHubService } from './sse-hub.service';

/**
 * Enterprise notification platform (additive). Event-driven: outbox → RabbitMQ →
 * consumer → builder → repository (fan-out) → channels (DB/SSE/push). Global so
 * the admin controllers can inject the services without extra wiring.
 */
@Global()
@Module({
  imports: [OutboxModule], // shared RabbitConnectionManager
  providers: [
    { provide: CONSUMERS_CONFIG, useFactory: () => loadConsumersConfig() },
    AdminNotificationMetrics,
    AdminNotificationRepository,
    SseHubService,
    FirebasePushChannel,
    AdminNotificationDispatcher,
    AdminNotificationConsumer,
    NotificationRetentionWorker,
  ],
  exports: [AdminNotificationRepository, AdminNotificationDispatcher, SseHubService, AdminNotificationMetrics],
})
export class AdminNotificationsModule {}
