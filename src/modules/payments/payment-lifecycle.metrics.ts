import { Injectable, Logger } from '@nestjs/common';
import { Counter } from 'prom-client';
import { MetricsRegistry } from '../../infrastructure/metrics/metrics.registry';

/** Telemetry for the payment reminder/expiry worker. Dual-emits logs + Prometheus. */
@Injectable()
export class PaymentLifecycleMetrics {
  private readonly logger = new Logger('PaymentLifecycle');
  private readonly reminderSent: Counter<string>; // {reminder=first|second}
  private readonly expired: Counter<string>;

  constructor(registry: MetricsRegistry) {
    this.reminderSent = registry.counter('masular_payment_reminder_sent_total', 'Payment reminders enqueued', ['reminder']);
    this.expired = registry.counter('masular_payment_expired_total', 'Payments auto-expired');
  }

  reminder(which: 'first' | 'second'): void {
    this.reminderSent.inc({ reminder: which });
    this.logger.log({ metric: 'payment.reminder.sent', reminder: which });
  }

  paymentExpired(): void {
    this.expired.inc();
    this.logger.log({ metric: 'payment.expired' });
  }
}
