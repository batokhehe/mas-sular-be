import { Injectable, Logger } from '@nestjs/common';

/**
 * Counter-style telemetry for checkout idempotency. Emitted as structured log
 * lines (a seam a real metrics backend can hook later). One method per metric so
 * call sites stay explicit and unit-testable.
 */
@Injectable()
export class CheckoutIdempotencyMetrics {
  private readonly logger = new Logger('CheckoutIdempotency');

  private emit(metric: string, fields: Record<string, unknown> = {}): void {
    this.logger.log({ metric, ...fields });
  }

  missingKey(): void {
    this.emit('checkout.idempotency.missing_key');
  }

  invalidKey(reason: string): void {
    this.emit('checkout.idempotency.invalid_key', { reason });
  }

  replay(): void {
    this.emit('checkout.idempotency.replay');
  }

  processingConflict(): void {
    this.emit('checkout.idempotency.processing_conflict');
  }

  fingerprintMismatch(): void {
    this.emit('checkout.idempotency.fingerprint_mismatch');
  }
}
