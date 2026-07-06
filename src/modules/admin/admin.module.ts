import { Module } from '@nestjs/common';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { OrderCancellationService } from '../orders/order-cancellation.service';
import { ShipmentModule } from '../shipment/shipment.module';
import { AdminCmsController } from './presentation/admin-cms.controller';
import { AdminCatalogController } from './presentation/admin-catalog.controller';
import { AdminOperationsController } from './presentation/admin-operations.controller';
import { AdminService } from './admin.service';
import { ExecutiveDashboardService } from './executive-dashboard.service';
import { AdminOrderNotesService } from './admin-order-notes.service';

@Module({
  imports: [ShipmentModule],
  controllers: [AdminCatalogController, AdminCmsController, AdminOperationsController],
  providers: [AdminService, ExecutiveDashboardService, AdminOrderNotesService, OrderCancellationService, PermissionGuard],
  exports: [AdminService],
})
export class AdminModule {}
