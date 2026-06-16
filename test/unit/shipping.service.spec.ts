import { ShippingService } from '../../src/modules/shipping/shipping.service';
import { PaxelProvider } from '../../src/modules/shipping/infrastructure/providers/paxel.provider';
import { JneProvider } from '../../src/modules/shipping/infrastructure/providers/jne.provider';

describe('ShippingService', () => {
  it('aggregates provider rates', async () => {
    const service = new ShippingService(new PaxelProvider(), new JneProvider());
    const rates = await service.calculateRates({
      originPostalCode: '10110',
      destinationPostalCode: '40115',
      weightGram: 1000,
    });

    expect(rates).toHaveLength(2);
  });
});
