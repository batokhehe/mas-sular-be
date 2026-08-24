import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../../infrastructure/idempotency/idempotency.module';
import { PaymentUploadModule } from '../payments/payment-upload.module';
import { ShippingModule } from '../shipping/shipping.module';
import { PaymentGatewayModule } from '../payments/gateway/payment-gateway.module';
import { OrdersService } from './orders.service';
import { CheckoutController } from './presentation/checkout.controller';
import { CheckoutIdempotencyMetrics } from './presentation/checkout-idempotency.metrics';
import { OrdersController } from './presentation/orders.controller';

/**
 * DeliveryCoverageModule is deliberately NOT imported.
 *
 * Shipping availability and price are Paxel's answer, not ours: the coverage
 * gate ran before the rate request, so a DISABLED or PICKUP_ONLY rule stopped an
 * address from ever reaching Paxel — even for areas Paxel serves. OrdersService
 * injects DeliveryCoverageService with @Optional(), so leaving it unwired makes
 * the gate a no-op while the model, its data, its API and the admin UI all stay
 * exactly as they are.
 *
 * To re-enable enforcement, add DeliveryCoverageModule back to `imports`.
 */
@Module({
  imports: [ShippingModule, IdempotencyModule, PaymentUploadModule, PaymentGatewayModule],
  controllers: [OrdersController, CheckoutController],
  providers: [OrdersService, CheckoutIdempotencyMetrics],
})
export class OrdersModule {}
