import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ShippingRateDto } from '../application/dto/shipping.dto';
import { ShippingService } from '../shipping.service';

@ApiTags('shipping')
@Controller({ path: 'shipping', version: '1' })
export class ShippingController {
  constructor(private readonly shipping: ShippingService) {}

  @Post('rates')
  rates(@Body() dto: ShippingRateDto) {
    return this.shipping.calculateRates(dto);
  }

  @Get(':provider/track/:trackingNumber')
  track(@Param('provider') provider: string, @Param('trackingNumber') trackingNumber: string) {
    return this.shipping.track(provider, trackingNumber);
  }
}
