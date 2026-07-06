import { Module } from '@nestjs/common';
import { AdminDeliveryCoverageController } from './presentation/admin-delivery-coverage.controller';
import { DeliveryCoverageController } from './presentation/delivery-coverage.controller';
import { DeliveryCoverageService } from './delivery-coverage.service';

@Module({
  controllers: [DeliveryCoverageController, AdminDeliveryCoverageController],
  providers: [DeliveryCoverageService],
  exports: [DeliveryCoverageService],
})
export class DeliveryCoverageModule {}
