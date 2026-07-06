import { Module } from '@nestjs/common';
import { OutletsController } from './presentation/outlets.controller';
import { OutletService } from './outlet.service';
import { OutletBootValidator } from './outlet-boot.validator';

@Module({
  controllers: [OutletsController],
  providers: [OutletService, OutletBootValidator],
  exports: [OutletService],
})
export class OutletsModule {}
