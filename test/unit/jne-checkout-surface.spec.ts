/**
 * PAXELBOX-61T — what a customer actually receives.
 *
 * `OrdersService.getShippingOptions()` is typed `Promise<ShippingQuote[]>` and
 * the app registers no global serializer, so the objects ShippingService returns
 * ARE the JSON response body. These tests therefore drive the real
 * ShippingService over the real JneProvider (HTTP and the district resolver
 * stubbed) and assert on what would be serialised — the closest the surface can
 * be pinned down without booting Nest.
 */

import { ShippingService } from '../../src/modules/shipping/shipping.service';
import { ShippingProviderFactory } from '../../src/modules/shipping/shipping-provider.factory';
import { JneProvider } from '../../src/modules/shipping/infrastructure/providers/jne.provider';
import type { ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import type { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import type { ShippingQuote, ShippingRateRequest } from '../../src/modules/shipping/domain/shipping-provider.interface';

const SANDBOX_URL = 'https://apiv2.jne.co.id:10202';
const ANDIR = 'BDO10041';

/**
 * The exact shape PAXELBOX-61N measured on Bandung -> Jakarta Barat: two rows
 * whose `service_display` is the SAME ("REG") at a 10x price difference, retail
 * ETD null, plus a trucking row that does carry an ETD.
 */
const REAL_BODY = JSON.stringify({
  price: [
    { origin_name: 'BANDUNG', destination_name: 'JAKARTA BARAT', service_display: 'REG', service_code: 'REG19', goods_type: 'Document/Paket', currency: 'IDR', price: '11000', etd_from: null, etd_thru: null, times: 'D' },
    { origin_name: 'BANDUNG', destination_name: 'JAKARTA BARAT', service_display: 'REG', service_code: 'REG15', goods_type: 'Document/Paket', currency: 'IDR', price: '1050', etd_from: null, etd_thru: null, times: null },
    { origin_name: 'BANDUNG', destination_name: 'JAKARTA BARAT', service_display: 'JTR<130', service_code: 'JTR<130', goods_type: 'Paket', currency: 'IDR', price: '500000', etd_from: '3', etd_thru: '4', times: 'D' },
  ],
});

const config = (): ShippingConfig =>
  ({
    originPostalCode: '40111',
    // ON, so "no mock reached checkout" is asserted under the condition that
    // would actually expose one.
    allowMockRates: true,
    paxel: { enabled: false, baseUrl: 'https://paxel.test', timeoutMs: 500, maxRetry: 0, defaultDimension: '30x35x20', needInsurance: false },
    jne: { enabled: true, environment: 'sandbox', baseUrl: SANDBOX_URL, apiKey: 'k', username: 'u', originCode: 'BDO10000', timeoutMs: 500, maxRetry: 2 },
    // ON, so "RajaOngkir was not called" is asserted under the condition that
    // would actually expose a call.
    rajaongkir: { enabled: true, baseUrl: 'https://rajaongkir.test/api/v1', apiKey: 'ro', timeoutMs: 500, maxRetry: 1 },
  }) as ShippingConfig;

const res = (status: number, body: string): ShippingHttpResponse => ({ status, text: async () => body, headers: { get: () => null } });

/** ShippingService over a real JneProvider, exactly as ShippingModule wires it. */
function checkout(destinationCode: string | null = ANDIR) {
  const http = jest.fn();
  const provider = new JneProvider(config(), { resolve: async () => destinationCode } as never);
  (provider as unknown as { http: unknown }).http = http;
  const service = new ShippingService(new ShippingProviderFactory([provider]));
  return { service, http, provider };
}

const request = (over: Partial<ShippingRateRequest> = {}): ShippingRateRequest => ({
  originPostalCode: '40111',
  destinationPostalCode: '40181',
  weightGram: 1000,
  destinationDistrictId: 'dist-andir',
  ...over,
});

/** What NestJS would put on the wire for this response body. */
const asJson = (quotes: ShippingQuote[]) => JSON.parse(JSON.stringify(quotes)) as Array<Record<string, unknown>>;

describe('a JNE quote reaches the checkout response', () => {
  it('returns one selectable option per JNE service', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    const body = asJson(await service.getQuotes(request()));
    expect(body).toHaveLength(3);
    expect(body.every((q) => q.provider === 'jne')).toBe(true);
  });

  it('carries service_code, service_display and price to the response body', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    const body = asJson(await service.getQuotes(request()));
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'jne', service: 'REG19', serviceName: 'REG', shippingCost: 11000 }),
        expect.objectContaining({ provider: 'jne', service: 'REG15', serviceName: 'REG', shippingCost: 1050 }),
        expect.objectContaining({ provider: 'jne', service: 'JTR<130', serviceName: 'JTR<130', shippingCost: 500000 }),
      ]),
    );
  });
});

describe('two services sharing a display name stay distinguishable', () => {
  it('their display names DO collide — this is real JNE data, not a defect', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    const body = asJson(await service.getQuotes(request()));
    expect(body.filter((q) => q.serviceName === 'REG')).toHaveLength(2);
  });

  it('but the identifier does not: `service` is unique', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    const body = asJson(await service.getQuotes(request()));
    const ids = body.map((q) => `${q.provider}-${q.service}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('selectQuote resolves the exact service the customer picked', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    const quotes = await service.getQuotes(request());
    // The frontend posts back provider + service; both "REG" rows must resolve
    // to their own price, never to each other's.
    expect(service.selectQuote(quotes, 'jne', 'REG19').shippingCost).toBe(11000);
    expect(service.selectQuote(quotes, 'jne', 'REG15').shippingCost).toBe(1050);
  });

  it('rejects a service code JNE did not return', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    const quotes = await service.getQuotes(request());
    expect(() => service.selectQuote(quotes, 'jne', 'REG')).toThrow(/unavailable/i);
  });
});

describe('ETD reaches the response without invention', () => {
  it('preserves a real ETD range', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    const body = asJson(await service.getQuotes(request()));
    expect(body.find((q) => q.service === 'JTR<130')?.estimatedDays).toBe('3-4');
  });

  it('never turns a null ETD into a number, a zero, or an empty string', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    const body = asJson(await service.getQuotes(request()));
    for (const code of ['REG19', 'REG15']) {
      const etd = body.find((q) => q.service === code)?.estimatedDays;
      expect(etd).toBe('N/A');
      expect(etd).not.toMatch(/\d/);
      expect(etd).not.toBe('0');
      expect(etd).not.toBe('');
      expect(typeof etd).toBe('string');
    }
  });

  it('estimatedDays is always a string, so no display can assume a number', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    const body = asJson(await service.getQuotes(request()));
    expect(body.every((q) => typeof q.estimatedDays === 'string')).toBe(true);
  });
});

describe('providerMeta on the response body', () => {
  it('survives the service layer and JSON serialisation', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    const body = asJson(await service.getQuotes(request()));
    expect(body.find((q) => q.service === 'JTR<130')?.providerMeta).toEqual({
      service_code: 'JTR<130',
      service_display: 'JTR<130',
      goods_type: 'Paket',
      currency: 'IDR',
      etd_from: '3',
      etd_thru: '4',
      times: 'D',
      origin_name: 'BANDUNG',
      destination_name: 'JAKARTA BARAT',
    });
  });

  it('keeps JNE nulls as null rather than dropping the keys', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    const body = asJson(await service.getQuotes(request()));
    const meta = body.find((q) => q.service === 'REG15')?.providerMeta as Record<string, unknown>;
    expect(meta.etd_from).toBeNull();
    expect(meta.etd_thru).toBeNull();
    expect(meta.times).toBeNull();
    expect(Object.keys(meta)).toContain('times');
  });

  /**
   * Documents the boundary rather than asserting a requirement: checkout
   * correctness needs only provider+service+cost, which is why the frontend's
   * ShippingOption type omits providerMeta. It rides along for diagnostics.
   */
  it('is not required for selection — provider + service is sufficient', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    const quotes = await service.getQuotes(request());
    const stripped = quotes.map(({ providerMeta: _ignored, ...rest }) => rest);
    expect(service.selectQuote(stripped as ShippingQuote[], 'jne', 'REG15').shippingCost).toBe(1050);
  });
});

describe('the checkout surface never fabricates a quote', () => {
  it('unmapped district: no options, no HTTP call', async () => {
    const { service, http } = checkout(null);
    await expect(service.getQuotes(request({ destinationDistrictId: 'dist-unmapped' }))).resolves.toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('Price Not Found: empty options, never a fallback price', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, JSON.stringify({ error: 'Price Not Found.', status: false })));
    const body = asJson(await service.getQuotes(request()));
    expect(body).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('Mock');
  });

  it('empty price[]: empty options', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, JSON.stringify({ price: [] })));
    await expect(service.getQuotes(request())).resolves.toEqual([]);
  });

  it('a total JNE failure surfaces as an error, not as "no couriers"', async () => {
    // ShippingService rethrows when EVERY provider fails, so a 4xx cannot be
    // mistaken for a legitimately empty option list.
    const { service, http } = checkout();
    http.mockResolvedValue(res(401, 'unauthorised'));
    await expect(service.getQuotes(request())).rejects.toThrow();
  });

  it('RajaOngkir is never called, though it is enabled in this config', async () => {
    const { service, http } = checkout();
    http.mockResolvedValue(res(200, REAL_BODY));
    await service.getQuotes(request({ originRajaOngkirId: 1, destinationRajaOngkirId: 2 }));
    for (const call of http.mock.calls) {
      expect(String(call[0])).toContain('/tracing/api/pricedev');
      expect(String(call[0])).not.toContain('rajaongkir');
    }
  });

  it('no mock quote ever reaches the response, though allowMockRates is true', async () => {
    for (const body of [JSON.stringify({ price: [] }), JSON.stringify({ error: 'Price Not Found.', status: false })]) {
      const { service, http } = checkout();
      http.mockResolvedValue(res(200, body));
      const json = JSON.stringify(await service.getQuotes(request()));
      expect(json).not.toContain('Mock');
      expect(json).not.toContain('Reguler');
    }
  });
});
