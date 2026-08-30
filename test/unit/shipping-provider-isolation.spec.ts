import { ShippingService } from '../../src/modules/shipping/shipping.service';
import { ShippingProviderFactory } from '../../src/modules/shipping/shipping-provider.factory';
import { PermanentError, TransientError } from '../../src/modules/shipping/domain/shipping-errors';
import {
  ShippingProvider,
  ShippingQuote,
  ShippingRateRequest,
} from '../../src/modules/shipping/domain/shipping-provider.interface';

/**
 * PAXELBOX-45A: one courier failing must not remove another courier's quotes.
 *
 * Before the fix ShippingService used Promise.all, so a single rejecting
 * provider rejected the whole aggregation and the customer saw NO shipping
 * options — including ones that had already been priced successfully.
 *
 * These tests are written to fail if collectQuotes is reverted to Promise.all:
 * each mixed case asserts the surviving provider's quotes are actually returned,
 * which a rejecting Promise.all can never do.
 */

class OkProvider implements ShippingProvider {
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

class FailingProvider implements ShippingProvider {
  constructor(
    readonly name: string,
    private readonly error: Error,
  ) {}
  async getRates(_request: ShippingRateRequest): Promise<ShippingQuote[]> {
    throw this.error;
  }
  async track(trackingNumber: string) {
    return { provider: this.name, trackingNumber, status: 'OK', history: [] };
  }
}

const paxelQuote: ShippingQuote = {
  provider: 'paxel',
  service: 'SAME_DAY',
  serviceName: 'Paxel Same Day',
  estimatedDays: 'Today',
  shippingCost: 18000,
};

const jneQuotes: ShippingQuote[] = [
  { provider: 'jne', service: 'REG', serviceName: 'JNE Regular', estimatedDays: '2-3 Days', shippingCost: 13000 },
  { provider: 'jne', service: 'YES', serviceName: 'JNE YES', estimatedDays: 'Tomorrow', shippingCost: 22000 },
];

const request: ShippingRateRequest = {
  originPostalCode: '10110',
  destinationPostalCode: '40115',
  weightGram: 1000,
};

function serviceWith(...providers: ShippingProvider[]) {
  return new ShippingService(new ShippingProviderFactory(providers));
}

describe('ShippingService provider isolation (PAXELBOX-45A)', () => {
  beforeEach(() => {
    // The service logs each isolated failure; keep the suite output clean.
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('Paxel succeeds + JNE throws → Paxel quotes survive', async () => {
    const service = serviceWith(
      new OkProvider('paxel', [paxelQuote]),
      new FailingProvider('jne', new TransientError('provider 429: Daily limit exceeded', 'jne')),
    );

    const quotes = await service.getQuotes(request);

    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ provider: 'paxel', service: 'SAME_DAY', shippingCost: 18000 });
  });

  it('JNE succeeds + Paxel throws → JNE quotes survive', async () => {
    const service = serviceWith(
      new FailingProvider('paxel', new TransientError('provider 503: upstream down', 'paxel')),
      new OkProvider('jne', jneQuotes),
    );

    const quotes = await service.getQuotes(request);

    expect(quotes).toHaveLength(2);
    expect(quotes.map((q) => `${q.provider}:${q.service}`)).toEqual(['jne:REG', 'jne:YES']);
  });

  it('every provider fails → the error still propagates (semantics preserved)', async () => {
    const service = serviceWith(
      new FailingProvider('paxel', new TransientError('provider 503: upstream down', 'paxel')),
      new FailingProvider('jne', new PermanentError('provider 422: invalid', 'jne')),
    );

    // Deterministically the FIRST provider's error, in registration order.
    await expect(service.getQuotes(request)).rejects.toBeInstanceOf(TransientError);
  });

  it('a programmer error that breaks every provider is NOT disguised as empty quotes', async () => {
    const service = serviceWith(
      new FailingProvider('paxel', new TypeError("Cannot read properties of undefined (reading 'x')")),
      new FailingProvider('jne', new TypeError('boom')),
    );

    await expect(service.getQuotes(request)).rejects.toBeInstanceOf(TypeError);
  });

  it('all providers succeed → behaviour is unchanged', async () => {
    const service = serviceWith(new OkProvider('paxel', [paxelQuote]), new OkProvider('jne', jneQuotes));

    const quotes = await service.getQuotes(request);

    expect(quotes).toHaveLength(3);
    expect(quotes.map((q) => `${q.provider}:${q.service}`)).toEqual([
      'paxel:SAME_DAY',
      'jne:REG',
      'jne:YES',
    ]);
  });

  it('no providers registered → empty list, not an error (Promise.all([]) parity)', async () => {
    await expect(serviceWith().getQuotes(request)).resolves.toEqual([]);
  });

  it('a provider returning zero quotes is not a failure', async () => {
    const service = serviceWith(new OkProvider('paxel', []), new OkProvider('jne', jneQuotes));

    await expect(service.getQuotes(request)).resolves.toHaveLength(2);
  });

  it('calculateRates (legacy) isolates a failing provider too', async () => {
    const service = serviceWith(
      new OkProvider('paxel', [paxelQuote]),
      new FailingProvider('jne', new TransientError('provider 429: Daily limit exceeded', 'jne')),
    );

    const rates = await service.calculateRates(request);

    expect(rates).toEqual([{ provider: 'paxel', service: 'SAME_DAY', cost: 18000, etd: 'Today' }]);
  });

  it('findQuote still resolves a surviving provider selection when another courier is down', async () => {
    const service = serviceWith(
      new FailingProvider('paxel', new TransientError('provider 429: Daily limit exceeded', 'paxel')),
      new OkProvider('jne', jneQuotes),
    );

    await expect(service.findQuote(request, 'jne', 'YES')).resolves.toMatchObject({ shippingCost: 22000 });
    // A service belonging to the DOWN courier is unavailable, not a 500.
    await expect(service.findQuote(request, 'paxel', 'SAME_DAY')).rejects.toThrow(
      'Selected shipping service is unavailable',
    );
  });
});
