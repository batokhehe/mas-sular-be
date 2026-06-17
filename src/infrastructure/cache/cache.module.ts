import { CacheModule } from '@nestjs/cache-manager';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { redisStore } from 'cache-manager-ioredis-yet';
import Redis from 'ioredis';

@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],

      useFactory: async (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL');

        console.log('CACHE REDIS URL =', url);

        const redis = new Redis(url!, {
          connectTimeout: 10000,
        });

        redis.on('connect', () => {
          console.log('CACHE TEST CONNECT');
        });

        redis.on('ready', () => {
          console.log('CACHE TEST READY');
        });

        redis.on('error', (err) => {
          console.error('CACHE TEST ERROR');
          console.error(err);
          console.error(err?.stack);
        });

        await redis.ping();

        const store = await redisStore({
          url: url!,
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
