import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../../infrastructure/idempotency/idempotency.module';
import { PaymentUploadModule } from '../payments/payment-upload.module';
import { ShippingModule } from '../shipping/shipping.module';
import { PaymentGatewayModule } from '../payments/gateway/payment-gateway.module';
import { DeliveryCoverageModule } from '../delivery-coverage/delivery-coverage.module';
import { OrdersService } from './orders.service';
import { CheckoutController } from './presentation/checkout.controller';
import { CheckoutIdempotencyMetrics } from './presentation/checkout-idempotency.metrics';
import { OrdersController } from './presentation/orders.controller';

@Module({
  imports: [ShippingModule, IdempotencyModule, PaymentUploadModule, DeliveryCoverageModule, PaymentGatewayModule],
  controllers: [OrdersController, CheckoutController],
  providers: [OrdersService, CheckoutIdempotencyMetrics],
})
export class OrdersModule {}
