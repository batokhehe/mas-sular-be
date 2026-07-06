import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CheckCoverageQueryDto } from '../application/dto/delivery-coverage.dto';
import { DeliveryCoverageService } from '../delivery-coverage.service';

/**
 * Public delivery-coverage check for checkout.
 *   GET /api/v1/delivery-coverage/check?provinceId=&cityId=&districtId=&villageId=
 * Returns coverageType, deliveryFee, minimumOrder, estimatedMinutes.
 */
@ApiTags('delivery-coverage')
@Controller({ path: 'delivery-coverage', version: '1' })
export class DeliveryCoverageController {
  constructor(private readonly service: DeliveryCoverageService) {}

  @Get('check')
  check(@Query() query: CheckCoverageQueryDto) {
    return this.service.check(query);
  }
}
