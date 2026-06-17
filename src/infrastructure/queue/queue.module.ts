import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config/dist/config.service';

export const QUEUES = {
  payments: 'payments',
  orders: 'orders',
  notifications: 'notifications',
  inventory: 'inventory',
} as const;

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('REDIS_URL'),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUES.payments },
      { name: QUEUES.orders },
      { name: QUEUES.notifications },
      { name: QUEUES.inventory },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule { }
