import { Module } from '@nestjs/common';
import { OrderCancellationService } from '../orders/order-cancellation.service';
import { PaymentUploadModule } from './payment-upload.module';
import { PAYMENT_LIFECYCLE_CONFIG, loadPaymentLifecycleConfig } from './payment-lifecycle.config';
import { PaymentLifecycleMetrics } from './payment-lifecycle.metrics';
import { PaymentLifecycleWorker } from './payment-lifecycle.worker';

/** Payment reminder + expiry worker (flag-gated, default off). */
@Module({
  imports: [PaymentUploadModule],
  providers: [
    { provide: PAYMENT_LIFECYCLE_CONFIG, useFactory: () => loadPaymentLifecycleConfig() },
    PaymentLifecycleMetrics,
    OrderCancellationService,
    PaymentLifecycleWorker,
  ],
})
export class PaymentLifecycleModule {}
