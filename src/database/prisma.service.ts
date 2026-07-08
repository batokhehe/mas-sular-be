import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { dbPerfRegistry, queryNameFromSql } from '../infrastructure/logging/db-perf.registry';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Query timings are emitted as EVENTS for the in-memory performance registry
    // (aggregates only — SQL is name-mapped then discarded). warn/error keep the
    // default stdout behavior, so existing logging is unchanged.
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });
    // $on('query') typing needs client generics Nest's DI pattern can't carry;
    // the runtime event API is stable, so a narrow cast is used instead.
    (this as unknown as { $on(event: 'query', cb: (e: { query: string; duration: number }) => void): void }).$on(
      'query',
      (e) => {
        try {
          dbPerfRegistry.record(queryNameFromSql(e.query), e.duration);
        } catch {
          // profiling must never break a query
        }
      },
    );
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
