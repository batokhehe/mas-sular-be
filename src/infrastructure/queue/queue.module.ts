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
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL');
        if (!url) {
          throw new Error('REDIS_URL is required for the BullMQ connection');
        }

        // BullMQ (5.x) destructures `url` out of the connection options and
        // constructs ioredis positionally (`new IORedis(url, rest)` in
        // redis-connection.js), so the host/auth are parsed and TLS is honored
        // for rediss:// URLs. Unlike the cache store, the object form is safe here.
        return { connection: { url } };
      },
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
