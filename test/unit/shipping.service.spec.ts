import { ShippingService } from '../../src/modules/shipping/shipping.service';
import { ShippingProviderFactory } from '../../src/modules/shipping/shipping-provider.factory';
import {
  ShippingProvider,
  ShippingQuote,
  ShippingRateRequest,
} from '../../src/modules/shipping/domain/shipping-provider.interface';

/** In-memory fake provider so the ShippingService aggregation logic is tested
 *  without any HTTP (the real Paxel/JNE clients have their own mocked-HTTP tests). */
class FakeProvider implements ShippingProvider {
  constructor(
    readonly name: string,
    private readonly quotes: ShippingQuote[],
  ) {}
  async getRates(_request: ShippingRateRequest): Promise<ShippingQuote[]> {
    return this.quotes;
  }
  async track(trackingNumber: string) {
    return { provider: this.name, trackingNumber, status: 'OK', history: [] };
  }
}

function buildService() {
  const paxel = new FakeProvider('paxel', [
    { provider: 'paxel', service: 'SAME_DAY', serviceName: 'Paxel Same Day', estimatedDays: 'Today', shippingCost: 18000 },
  ]);
  const jne = new FakeProvider('jne', [
    { provider: 'jne', service: 'REG', serviceName: 'JNE Regular', estimatedDays: '2-3 Days', shippingCost: 13000 },
    { provider: 'jne', service: 'YES', serviceName: 'JNE YES', estimatedDays: 'Tomorrow', shippingCost: 22000 },
  ]);
  return new ShippingService(new ShippingProviderFactory([paxel, jne]));
}

const request = { originPostalCode: '10110', destinationPostalCode: '40115', weightGram: 1000 };

describe('ShippingService', () => {
  it('aggregates one representative rate per provider (legacy)', async () => {
    const rates = await buildService().calculateRates(request);
    expect(rates).toHaveLength(2);
  });

  it('getQuotes returns every service from every provider', async () => {
    const quotes = await buildService().getQuotes(request);
    expect(quotes).toHaveLength(3);
    expect(quotes.map((q) => `${q.provider}:${q.service}`)).toEqual(
      expect.arrayContaining(['paxel:SAME_DAY', 'jne:REG', 'jne:YES']),
    );
  });

  it('findQuote resolves a selected service and rejects unknown ones', async () => {
    const service = buildService();
    const quote = await service.findQuote(request, 'jne', 'YES');
    expect(quote.serviceName).toContain('JNE YES');
    await expect(service.findQuote(request, 'jne', 'NOPE')).rejects.toThrow();
  });
});
