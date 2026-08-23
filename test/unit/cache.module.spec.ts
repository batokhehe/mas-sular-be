import { KeyvAdapter, type CacheManagerStore } from 'cache-manager';
import Redis from 'ioredis';
import { readFileSync } from 'fs';
import { join } from 'path';
import { cacheOptions, redisStore, CacheRedisClient } from '../../src/infrastructure/cache/cache.module';

/**
 * Regression for F79.
 *
 * The cache was configured with cache-manager v5's singular `store:` key while
 * cache-manager v6 / @nestjs/cache-manager v3 read only `stores:`. Neither package
 * references the singular key, so it was discarded without a warning and the cache
 * silently fell back to an in-process Keyv-over-Map. Redis was connected and never
 * written to.
 *
 * Nothing exercised through the Cache interface could have caught that - set and get
 * both "worked". These tests therefore assert the option SHAPE and the routing of
 * operations to the supplied store. Real Redis behaviour is proved separately at
 * runtime against a disposable Redis, not mocked here.
 */

// Never connects: lazyConnect defers the socket, and nothing here issues a command.
function stubClient(): Redis {
  return new Redis({ lazyConnect: true });
}

describe('cacheOptions - the shape cache-manager actually reads', () => {
  let client: Redis;
  beforeEach(() => { client = stubClient(); });
  afterEach(() => { client.disconnect(); });

  it('uses `stores` (plural) and never the ignored singular `store` key', () => {
    const options = cacheOptions({ client } as CacheRedisClient);
    expect(Array.isArray(options.stores)).toBe(true);
    expect(options.stores).toHaveLength(1);
    expect(options).not.toHaveProperty('store');
  });

  it('wraps the Redis store in a KeyvAdapter', () => {
    const options = cacheOptions({ client } as CacheRedisClient);
    expect(options.stores[0]).toBeInstanceOf(KeyvAdapter);
  });

  it('keeps the 60s entry lifetime', () => {
    expect(cacheOptions({ client } as CacheRedisClient).ttl).toBe(60_000);
  });
});

describe('redisStore - the runtime shape the compiler cannot check', () => {
  // cache-manager-ioredis-yet declares `RedisStore extends Store`, importing `Store`
  // from cache-manager - which v6 no longer exports. Its public type therefore
  // collapses to isCacheable + client, and redisStore() has to assert the real shape.
  // This asserts it for real, so an upgrade that changes the store fails here rather
  // than degrading the cache in production.
  const REQUIRED: Array<keyof CacheManagerStore> = ['name', 'get', 'mget', 'set', 'mset', 'del', 'mdel', 'ttl', 'keys'];

  it('exposes every member CacheManagerStore requires', () => {
    const client = stubClient();
    const store = redisStore(client);
    for (const member of REQUIRED) {
      expect(store).toHaveProperty(member);
      if (member !== 'name') expect(typeof store[member]).toBe('function');
    }
    expect(store.name).toBe('redis');
    client.disconnect();
  });

  it('is accepted by KeyvAdapter, which exposes the Keyv storage surface', () => {
    const client = stubClient();
    const adapter = new KeyvAdapter(redisStore(client));
    for (const member of ['get', 'set', 'delete', 'clear'] as const) {
      expect(typeof adapter[member]).toBe('function');
    }
    client.disconnect();
  });
});

describe('operations reach the supplied store', () => {
  // A CacheManagerStore backed by a Map stands in for Redis: the point is not what
  // stores the data, it is that set/get/del arrive at the store we configured. Under
  // the old `store:` config they never did - they went to cache-manager's own
  // fallback and this store stayed empty.
  function recordingStore() {
    const data = new Map<string, unknown>();
    const store: CacheManagerStore = {
      name: 'recording',
      async get(key: string) { return data.get(key); },
      async mget(...keys: string[]) { return keys.map((k) => data.get(k)); },
      async set(key: string, value: unknown) { data.set(key, value); },
      async mset(entries: Record<string, unknown>) { Object.entries(entries).forEach(([k, v]) => data.set(k, v)); },
      async del(key: string) { data.delete(key); },
      async mdel(...keys: string[]) { keys.forEach((k) => data.delete(k)); },
      async ttl() { return 60_000; },
      async keys() { return [...data.keys()]; },
      async reset() { data.clear(); },
    };
    return { store, data };
  }

  // The same factory Nest itself uses to turn module options into a CACHE_MANAGER.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCacheManager } = require('@nestjs/cache-manager/dist/cache.providers');

  it('set, get and del all land on the configured store', async () => {
    const { store, data } = recordingStore();
    const cache = await createCacheManager().useFactory({ stores: [new KeyvAdapter(store)], ttl: 60_000 });

    expect(data.size).toBe(0);
    await cache.set('f79-unit-key', 'value');
    expect(data.size).toBe(1); // it reached the store, not an internal fallback

    expect(await cache.get('f79-unit-key')).toBe('value');

    await cache.del('f79-unit-key');
    expect(await cache.get('f79-unit-key')).toBeNull();
    expect([...data.keys()].filter((k) => k.includes('f79-unit-key'))).toHaveLength(0);
  });
});

describe('the packages still ignore the singular option', () => {
  it('@nestjs/cache-manager reads options.stores and never options.store', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'node_modules', '@nestjs', 'cache-manager', 'dist', 'cache.providers.js'),
      'utf8',
    );
    expect(src).toMatch(/options\.stores/);
    // If a future version starts honouring the singular key, this fails and the
    // comment in cache.module.ts explaining why we use `stores` needs revisiting.
    expect(src).not.toMatch(/options\.store\b/);
  });
});

// ============================================ cached payloads must be serialisable ==
//
// The pre-F79 cache held values in an in-process Map, by reference: a Date written
// to the cache came back as a Date. Redis stores JSON, so a Date now comes back as a
// string. Any cached payload carrying a raw Date would therefore behave differently
// on a cache HIT than on a MISS - an intermittent bug that only appears on the second
// request within the 30s window.
//
// This is a compile-time assertion, not a runtime one: if a Date ever reaches a
// cached payload type, `HasDate` widens to boolean and this file stops compiling.

import type { ExecutiveDashboardService } from '../../src/modules/admin/executive-dashboard.service';
import type { SystemDashboardService } from '../../src/infrastructure/logging/system-dashboard.service';
import type { NotificationCenterService } from '../../src/infrastructure/lifecycle/notification-center.service';
import type { QueueCenterService } from '../../src/infrastructure/lifecycle/queue-center.service';

type HasDate<T> = T extends Date
  ? true
  : T extends readonly (infer U)[]
    ? HasDate<U>
    : T extends object
      ? { [K in keyof T]: HasDate<T[K]> }[keyof T]
      : false;

type Payload<S, M extends keyof S> = S[M] extends (...args: never[]) => infer R ? Awaited<R> : never;

describe('cached payloads survive a JSON round-trip', () => {
  it('no cached payload type carries a raw Date', () => {
    const executive: HasDate<Payload<ExecutiveDashboardService, 'getDashboard'>> = false;
    const system: HasDate<Payload<SystemDashboardService, 'getDashboard'>> = false;
    const notifications: HasDate<Payload<NotificationCenterService, 'overview'>> = false;
    const queues: HasDate<Payload<QueueCenterService, 'overview'>> = false;
    expect([executive, system, notifications, queues]).toEqual([false, false, false, false]);
  });
});
