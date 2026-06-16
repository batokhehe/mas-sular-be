import { Module } from '@nestjs/common';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { UploadModule } from '../upload/upload.module';
import { PaymentUploadModule } from './payment-upload.module';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './presentation/payments.controller';

@Module({
  imports: [PaymentUploadModule, UploadModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PermissionGuard],
})
export class PaymentsModule {}
