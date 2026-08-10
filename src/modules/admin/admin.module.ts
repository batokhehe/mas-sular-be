import { Module } from '@nestjs/common';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { LifecycleModule } from '../../infrastructure/lifecycle/lifecycle.module';
import { OrderCancellationService } from '../orders/order-cancellation.service';
import { PaymentSettlementModule } from '../payments/settlement/payment-settlement.module';
import { ShipmentModule } from '../shipment/shipment.module';
import { AdminCmsController } from './presentation/admin-cms.controller';
import { AdminCatalogController } from './presentation/admin-catalog.controller';
import { AdminOperationsController } from './presentation/admin-operations.controller';
import { AdminSystemLogController } from './presentation/admin-system-log.controller';
import { AdminQueueController } from './presentation/admin-queue.controller';
import { AdminIncidentController } from './presentation/admin-incident.controller';
import { AdminNotificationCenterController } from './presentation/admin-notification-center.controller';
import { AdminAuditController } from './presentation/admin-audit.controller';
import { AdminBellController, AdminPushController } from './presentation/admin-bell.controller';
import { AdminCommunicationController } from './presentation/admin-communication.controller';
import { AdminService } from './admin.service';
import { CustomerCommunicationService } from './customer-communication.service';
import { ExecutiveDashboardService } from './executive-dashboard.service';
import { AdminOrderNotesService } from './admin-order-notes.service';

@Module({
  imports: [ShipmentModule, LifecycleModule, PaymentSettlementModule],
  controllers: [AdminCatalogController, AdminCmsController, AdminOperationsController, AdminSystemLogController, AdminQueueController, AdminIncidentController, AdminNotificationCenterController, AdminCommunicationController, AdminAuditController, AdminBellController, AdminPushController],
  providers: [AdminService, ExecutiveDashboardService, AdminOrderNotesService, OrderCancellationService, CustomerCommunicationService, PermissionGuard],
  exports: [AdminService],
})
export class AdminModule {}
