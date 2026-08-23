import { CacheModule } from '@nestjs/cache-manager';
import { Global, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KeyvAdapter, type CacheManagerStore } from 'cache-manager';
import { redisInsStore } from 'cache-manager-ioredis-yet';
import Redis from 'ioredis';

/** Entry lifetime for every cached value. Named so the two call sites cannot drift. */
const CACHE_TTL_MS = 60_000;

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

    // Fail fast, do not hang. With ioredis defaults and Redis unreachable, a cache
    // command sits in the offline queue across maxRetriesPerRequest (20) reconnect
    // attempts, each burning the full connectTimeout - a measured 158-300s before
    // /health/ready could answer, and the same block on every cached dashboard
    // endpoint. Every consumer already catches cache errors and serves uncached, so
    // a fast failure is harmless; a slow one is not. Bounded here, on the CACHE
    // client only - BullMQ owns its own connection in queue.module.ts.
    this.client = new Redis(url, {
      connectTimeout: 10_000,
      commandTimeout: 2_000,
      maxRetriesPerRequest: 1,
    });

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

/**
 * The ioredis-yet store, typed as cache-manager's `CacheManagerStore`.
 *
 * The assertion is unavoidable, and narrow. `cache-manager-ioredis-yet` declares
 * `RedisStore extends Store` and imports `Store`/`Config` from 'cache-manager' -
 * but v6 exports neither, so its public type collapses to just `isCacheable` and
 * `client`, and TypeScript reports the other eight members as missing. The runtime
 * object has all of them (get, mget, set, mset, del, mdel, ttl, keys, reset); only
 * the declaration is broken. `name` is genuinely absent and is supplied here - it
 * is used for diagnostics only.
 *
 * Because the compiler cannot check this shape, `cache.module.spec.ts` asserts at
 * runtime that every member `CacheManagerStore` requires is actually present. If a
 * future upgrade changes the store, that test fails instead of the cache silently
 * misbehaving.
 */
export function redisStore(client: Redis): CacheManagerStore {
  const store = redisInsStore(client, { ttl: CACHE_TTL_MS });
  return Object.assign(store, { name: 'redis' }) as unknown as CacheManagerStore;
}

/**
 * Options handed to cache-manager. Exported so `cache.module.spec.ts` can assert the
 * shape directly - the F79 defect was a silently-ignored option key, which no
 * amount of testing through the cache interface would have caught.
 *
 * `stores` (plural), NOT `store`. cache-manager v6 and
 * @nestjs/cache-manager v3 are Keyv-based and read ONLY `options.stores`;
 * the v5-era singular `store` key is never referenced by either package,
 * so it was silently discarded and the cache fell back to cache-manager's
 * default in-process Keyv-over-Map. Redis stayed connected and was never
 * written to: a readiness probe that set and read a key left Redis DBSIZE
 * at 0, and two processes never saw each other's entries.
 *
 * KeyvAdapter is exported by cache-manager itself, so this needs no new
 * dependency. It bridges the v5-shaped ioredis-yet store to the Keyv
 * storage-adapter interface - get/set/delete/clear rather than
 * get/set/del/reset. Passing the raw store here instead throws
 * "Invalid storage adapter" at boot. @nestjs/cache-manager wraps this
 * adapter in `new Keyv({ store, ttl })` itself, which is why `keyv` is not
 * imported directly: it is not a declared dependency, and pnpm's strict
 * node_modules layout would not resolve it.
 */
export function cacheOptions(redis: CacheRedisClient) {
  return {
    stores: [new KeyvAdapter(redisStore(redis.client))],
    ttl: CACHE_TTL_MS,
  };
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
      useFactory: cacheOptions,
    }),
  ],
  exports: [CacheModule],
})
export class CacheInfrastructureModule {}
