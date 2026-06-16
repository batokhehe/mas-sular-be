import { Module } from '@nestjs/common';
import { JneProvider } from './infrastructure/providers/jne.provider';
import { PaxelProvider } from './infrastructure/providers/paxel.provider';
import { ShippingController } from './presentation/shipping.controller';
import { ShippingService } from './shipping.service';

@Module({
  controllers: [ShippingController],
  providers: [ShippingService, PaxelProvider, JneProvider],
  exports: [ShippingService],
})
export class ShippingModule {}
