import { Module } from '@nestjs/common';
import { RegionsController } from './presentation/regions.controller';
import { RegionsService } from './regions.service';

@Module({
  controllers: [RegionsController],
  providers: [RegionsService],
  exports: [RegionsService],
})
export class RegionsModule {}
