import { Injectable } from '@nestjs/common';
import { ShippingProvider, ShippingRateRequest, TrackingResult } from '../../domain/shipping-provider.interface';

@Injectable()
export class PaxelProvider implements ShippingProvider {
  readonly name = 'paxel';

  async calculateRates(request: ShippingRateRequest) {
    return [{ provider: this.name, service: 'Same Day', cost: Math.max(12000, Math.ceil(request.weightGram / 1000) * 9000), etd: '1 day' }];
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    return { provider: this.name, trackingNumber, status: 'IN_TRANSIT', history: [] };
  }
}
