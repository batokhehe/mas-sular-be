import { CacheModule } from '@nestjs/cache-manager';
import { Global, Module } from '@nestjs/common';
import { redisStore } from 'cache-manager-ioredis-yet';

@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => {
        const store = await redisStore({
          url: process.env.REDIS_URL,
        });

        return {
          store,
          ttl: 60000,
        };
      }
    }),
  ],
  exports: [CacheModule],
})
export class CacheInfrastructureModule { }
