import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { appConfig } from './common/config/app.config';
import { validateEnv } from './common/config/env.validation';
import { redactSensitivePath } from './common/logging/redact';
import { DatabaseModule } from './database/database.module';
import { CacheInfrastructureModule } from './infrastructure/cache/cache.module';
import { ConsumersModule } from './infrastructure/consumers/consumers.module';
import { LifecycleModule } from './infrastructure/lifecycle/lifecycle.module';
import { LoggingModule } from './infrastructure/logging/logging.module';
import { AuditTrailModule } from './infrastructure/audit/audit.module';
import { AdminNotificationsModule } from './infrastructure/admin-notifications/admin-notifications.module';
import { MetricsModule } from './infrastructure/metrics/metrics.module';
import { NotificationsModule } from './infrastructure/notifications/notifications.module';
import { OutboxModule } from './infrastructure/outbox/outbox.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { AuditModule } from './modules/audit/audit.module';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { CartModule } from './modules/cart/cart.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CmsModule } from './modules/cms/cms.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PaymentGatewayModule } from './modules/payments/gateway/payment-gateway.module';
import { PaymentAccountsModule } from './modules/payment-accounts/payment-accounts.module';
import { PaymentLifecycleModule } from './modules/payments/payment-lifecycle.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { ShipmentModule } from './modules/shipment/shipment.module';
import { OutletsModule } from './modules/outlets/outlets.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { UsersModule } from './modules/users/users.module';
import { RegionsModule } from './modules/regions/regions.module';
import { DeliveryCoverageModule } from './modules/delivery-coverage/delivery-coverage.module';
import { HealthController } from './health.controller';
import { UploadModule } from './modules/upload/upload.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig], validate: validateEnv }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        // Headers fully censored; the request URL is partially censored so the
        // payment-upload token segment never reaches request logs.
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'req.url'],
          censor: (value: unknown, path: string[]) =>
            path[path.length - 1] === 'url' ? redactSensitivePath(String(value)) : '[Redacted]',
        },
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    CacheInfrastructureModule,
    MetricsModule,
    QueueModule,
    OutboxModule,
    LoggingModule,
    AuditTrailModule,
    AdminNotificationsModule,
    NotificationsModule,
    ConsumersModule,
    LifecycleModule,
    AuthModule,
    AdminAuthModule,
    AdminModule,
    UsersModule,
    RegionsModule,
    DeliveryCoverageModule,
    CatalogModule,
    CartModule,
    OrdersModule,
    PaymentsModule,
    PaymentGatewayModule,
    PaymentAccountsModule,
    PaymentLifecycleModule,
    ShippingModule,
    ShipmentModule,
    OutletsModule,
    InventoryModule,
    CmsModule,
    AuditModule,
    UploadModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
