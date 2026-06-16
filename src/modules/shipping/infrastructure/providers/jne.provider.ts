import { Injectable } from '@nestjs/common';
import { ShippingProvider, ShippingRateRequest, TrackingResult } from '../../domain/shipping-provider.interface';

@Injectable()
export class JneProvider implements ShippingProvider {
  readonly name = 'jne';

  async calculateRates(request: ShippingRateRequest) {
    return [{ provider: this.name, service: 'REG', cost: Math.max(10000, Math.ceil(request.weightGram / 1000) * 8000), etd: '2-3 days' }];
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    return { provider: this.name, trackingNumber, status: 'PENDING', history: [] };
  }
}
