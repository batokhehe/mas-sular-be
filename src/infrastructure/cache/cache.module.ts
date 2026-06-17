import { CacheModule } from '@nestjs/cache-manager';
import { Global, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { redisInsStore } from 'cache-manager-ioredis-yet';
import Redis from 'ioredis';

/**
 * Owns the single ioredis connection used by the cache.
 *
 * The URL is passed to ioredis as a STRING argument, not as `{ url }`. ioredis
 * only runs its URL parser on a string argument; an object's `url` key is
 * ignored and the client silently falls back to localhost:6379 with no TLS
 * (the cause of the previous ECONNREFUSED/ETIMEDOUT). Passing the string makes
 * ioredis parse host/auth and enable TLS automatically for `rediss://` URLs.
 *
 * Implements OnApplicationShutdown so the connection is closed cleanly on
 * SIGTERM/SIGINT (shutdown hooks are enabled in main.ts).
 */
@Injectable()
export class CacheRedisClient implements OnApplicationShutdown {
  private readonly logger = new Logger('CacheRedis');
  readonly client: Redis;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');
    if (!url) {
      throw new Error('REDIS_URL is required for the cache connection');
    }

    this.client = new Redis(url, { connectTimeout: 10_000 });

    // An attached listener turns a connection blip into a logged error instead
    // of an unhandled 'error' event (which ioredis would otherwise print as
    // "[ioredis] Unhandled error event").
    this.client.on('error', (err) => this.logger.error(`Redis cache connection error: ${err.message}`));
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      // Register the client provider inside the cache module so the factory can
      // inject the one shared instance (no duplicate connection).
      extraProviders: [CacheRedisClient],
      inject: [CacheRedisClient],
      useFactory: (redis: CacheRedisClient) => ({
        store: redisInsStore(redis.client, { ttl: 60_000 }),
        ttl: 60_000,
      }),
    }),
  ],
  exports: [CacheModule],
})
export class CacheInfrastructureModule {}
