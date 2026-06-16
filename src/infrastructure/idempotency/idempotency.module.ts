import { Module } from '@nestjs/common';
import { IDEMPOTENCY_CONFIG, loadIdempotencyConfig } from './idempotency.config';
import { IdempotencyService } from './idempotency.service';

@Module({
  providers: [
    { provide: IDEMPOTENCY_CONFIG, useFactory: () => loadIdempotencyConfig() },
    IdempotencyService,
  ],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
