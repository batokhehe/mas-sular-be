import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { LIFECYCLE_CONFIG, loadLifecycleConfig } from './lifecycle.config';
import { LifecycleMetrics } from './lifecycle.metrics';
import { NotificationCenterService } from './notification-center.service';
import { QueueCenterService } from './queue-center.service';
import { RedriveService } from './redrive.service';
import { RetentionWorker } from './retention.worker';

@Module({
  imports: [OutboxModule], // for the shared RabbitConnectionManager (DLQ shovel)
  providers: [
    { provide: LIFECYCLE_CONFIG, useFactory: () => loadLifecycleConfig() },
    LifecycleMetrics,
    RetentionWorker,
    RedriveService,
    QueueCenterService,
    NotificationCenterService,
  ],
  exports: [RedriveService, QueueCenterService, NotificationCenterService],
})
export class LifecycleModule {}
