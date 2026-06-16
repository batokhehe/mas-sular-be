import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ShippingProvider } from './domain/shipping-provider.interface';
import { JneProvider } from './infrastructure/providers/jne.provider';
import { PaxelProvider } from './infrastructure/providers/paxel.provider';
import { ShippingRateDto } from './application/dto/shipping.dto';

@Injectable()
export class ShippingService {
  private readonly providers: ShippingProvider[];

  constructor(paxel: PaxelProvider, jne: JneProvider) {
    this.providers = [paxel, jne];
  }

  async calculateRates(dto: ShippingRateDto) {
    return (await Promise.all(this.providers.map((provider) => provider.calculateRates(dto)))).flat();
  }

  async calculateRateForCourier(courier: string, dto: ShippingRateDto) {
    const provider = this.providers.find((candidate) => candidate.name === courier);
    if (!provider) throw new BadRequestException('Unsupported courier');

    const [rate] = await provider.calculateRates(dto);
    if (!rate) throw new BadRequestException('Shipping rate is unavailable');
    return rate;
  }

  async track(providerName: string, trackingNumber: string) {
    const provider = this.providers.find((candidate) => candidate.name === providerName);
    if (!provider) throw new NotFoundException('Shipping provider not found');
    return provider.track(trackingNumber);
  }
}
