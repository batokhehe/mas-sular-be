/**
 * PAXELBOX-61S — JNE quotation from JNE's OWN tariff API.
 *
 * This suite replaced the RajaOngkir-sourced one. RajaOngkir is parked for JNE
 * quotation: the tests below assert not only that pricedev is called, but that
 * nothing falls back to RajaOngkir or to a mock when JNE says no.
 *
 * All HTTP is mocked. The one real sandbox call this phase makes lives in the
 * PAXELBOX-61S smoke test, not here.
 */

import { JneProvider } from '../../src/modules/shipping/infrastructure/providers/jne.provider';
import type { ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import type { ShippingConfig, JneProviderConfig } from '../../src/modules/shipping/shipping.config';
import type { ShippingRateRequest } from '../../src/modules/shipping/domain/shipping-provider.interface';

const SANDBOX_URL = 'https://apiv2.jne.co.id:10202';
const ORIGIN = 'BDO10000';
const ANDIR = 'BDO10041';

/** A real 61N-shaped response: retail services with NULL ETD, plus trucking. */
const OK_BODY = JSON.stringify({
  price: [
    { origin_name: 'BANDUNG', destination_name: 'JAKARTA BARAT', service_display: 'YES', service_code: 'YES19', goods_type: 'Document/Paket', currency: 'IDR', price: '15000', etd_from: null, etd_thru: null, times: 'D' },
    { origin_name: 'BANDUNG', destination_name: 'JAKARTA BARAT', service_display: 'REG', service_code: 'REG19', goods_type: 'Document/Paket', currency: 'IDR', price: '11000', etd_from: null, etd_thru: null, times: 'D' },
    { origin_name: 'BANDUNG', destination_name: 'JAKARTA BARAT', service_display: 'REG', service_code: 'REG15', goods_type: 'Document/Paket', currency: 'IDR', price: '1050', etd_from: null, etd_thru: null, times: null },
    { origin_name: 'BANDUNG', destination_name: 'JAKARTA BARAT', service_display: 'JTR<130', service_code: 'JTR<130', goods_type: 'Paket', currency: 'IDR', price: '500000', etd_from: '3', etd_thru: '4', times: 'D' },
  ],
});

function config(over: Partial<JneProviderConfig> = {}): ShippingConfig {
  return {
    originPostalCode: '40111',
    // Deliberately TRUE: the native path must never produce a mock quote even
    // when the mock switch is on, which is the state development runs in.
    allowMockRates: true,
    paxel: { enabled: false, baseUrl: 'https://paxel.test', timeoutMs: 500, maxRetry: 0, defaultDimension: '30x35x20', needInsurance: false },
    jne: {
      enabled: true,
      environment: 'sandbox',
      baseUrl: SANDBOX_URL,
      apiKey: 'jne-secret',
      username: 'jne-user',
      originCode: ORIGIN,
      timeoutMs: 500,
      maxRetry: 2,
      ...over,
    },
    // Enabled on purpose: if any RajaOngkir call survived, these tests would see it.
    rajaongkir: { enabled: true, baseUrl: 'https://rajaongkir.test/api/v1', apiKey: 'ro-secret', timeoutMs: 500, maxRetry: 1 },
  } as ShippingConfig;
}

const res = (status: number, body: string): ShippingHttpResponse => ({ status, text: async () => body, headers: { get: () => null } });

/** Resolver double: returns `code` for any district id, or null to simulate no mapping. */
const resolver = (code: string | null) => ({ resolve: async () => code }) as never;

function build(code: string | null = ANDIR, over: Partial<JneProviderConfig> = {}) {
  const http = jest.fn();
  const provider = new JneProvider(config(over), resolver(code));
  (provider as unknown as { http: unknown }).http = http;
  return { provider, http };
}

const request = (over: Partial<ShippingRateRequest> = {}): ShippingRateRequest => ({
  originPostalCode: '40111',
  destinationPostalCode: '40181',
  weightGram: 1000,
  destinationDistrictId: 'dist-andir',
  ...over,
});

const bodyOf = (http: jest.Mock) => new URLSearchParams(String(http.mock.calls[0][1].body));

describe('provider identity', () => {
  it('is still named "jne"', () => {
    expect(build().provider.name).toBe('jne');
  });

  it('labels its quotes as jne', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    const quotes = await provider.getRates(request());
    expect(quotes.every((q) => q.provider === 'jne')).toBe(true);
  });
});

describe('the JNE pricedev request', () => {
  it('POSTs form-urlencoded to JNE, not RajaOngkir', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    await provider.getRates(request());
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][0]).toBe(`${SANDBOX_URL}/tracing/api/pricedev`);
    expect(http.mock.calls[0][1].method).toBe('POST');
    expect(http.mock.calls[0][1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(http.mock.calls[0][1].headers.Accept).toBe('application/json');
  });

  it('sends the configured origin code as `from`', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    await provider.getRates(request());
    expect(bodyOf(http).get('from')).toBe(ORIGIN);
  });

  it('sends the RESOLVED destination code as `thru`, never the postal code', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    await provider.getRates(request({ destinationPostalCode: '40181' }));
    expect(bodyOf(http).get('thru')).toBe(ANDIR);
    expect(String(http.mock.calls[0][1].body)).not.toContain('40181');
  });

  describe('weight is sent in KILOGRAMS', () => {
    it.each([
      [1000, '1'],
      [500, '1'],
      [1500, '2'],
      [1, '1'],
      [0, '1'],
      [2000, '2'],
      [2001, '3'],
    ])('%d g -> %s kg', async (grams, kg) => {
      const { provider, http } = build();
      http.mockResolvedValue(res(200, OK_BODY));
      await provider.getRates(request({ weightGram: grams }));
      expect(bodyOf(http).get('weight')).toBe(kg);
    });

    it('never sends grams', async () => {
      const { provider, http } = build();
      http.mockResolvedValue(res(200, OK_BODY));
      await provider.getRates(request({ weightGram: 1200 }));
      expect(bodyOf(http).get('weight')).toBe('2');
    });

    it('matches the rounding JneShipmentProvider books with', async () => {
      // Quote and booking must describe the same parcel: both use ceil, floor 1.
      const bookingRounding = (g: number) => Math.max(1, Math.ceil(g / 1000));
      for (const g of [1, 500, 1000, 1200, 1500, 2000, 2001]) {
        const { provider, http } = build();
        http.mockResolvedValue(res(200, OK_BODY));
        await provider.getRates(request({ weightGram: g }));
        expect(bodyOf(http).get('weight')).toBe(String(bookingRounding(g)));
      }
    });
  });

  it('carries credentials in the body per JNE contract, and never in the URL', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    await provider.getRates(request());
    expect(bodyOf(http).get('username')).toBe('jne-user');
    expect(bodyOf(http).get('api_key')).toBe('jne-secret');
    expect(String(http.mock.calls[0][0])).not.toContain('jne-secret');
  });
});

describe('destination resolution gates the call', () => {
  it('makes NO HTTP call when the district has no mapping', async () => {
    const { provider, http } = build(null);
    await expect(provider.getRates(request())).resolves.toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('makes NO HTTP call when the request carries no district id', async () => {
    const { provider, http } = build(null);
    await expect(provider.getRates(request({ destinationDistrictId: undefined }))).resolves.toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('makes NO HTTP call when the origin code is unset', async () => {
    const { provider, http } = build(ANDIR, { originCode: undefined });
    await expect(provider.getRates(request())).resolves.toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('makes NO HTTP call when credentials are missing', async () => {
    const { provider, http } = build(ANDIR, { apiKey: undefined });
    await expect(provider.getRates(request())).resolves.toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });
});

describe('response mapping', () => {
  it('returns one quote per JNE service', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    const quotes = await provider.getRates(request());
    expect(quotes).toHaveLength(4);
    expect(quotes.map((q) => q.service)).toEqual(['YES19', 'REG19', 'REG15', 'JTR<130']);
  });

  it('preserves service_code verbatim — REG15 and REG19 stay distinct', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    const quotes = await provider.getRates(request());
    const codes = quotes.map((q) => q.service);
    expect(codes).toContain('REG15');
    expect(codes).toContain('REG19');
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('does not rewrite an unusual service code', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    const quotes = await provider.getRates(request());
    expect(quotes.find((q) => q.service === 'JTR<130')).toBeDefined();
  });

  it('maps service_display to serviceName even when it repeats across rows', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    const quotes = await provider.getRates(request());
    expect(quotes.filter((q) => q.serviceName === 'REG')).toHaveLength(2);
  });

  it('maps the string price to a number', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    const quotes = await provider.getRates(request());
    expect(quotes.find((q) => q.service === 'REG19')?.shippingCost).toBe(11000);
    expect(quotes.find((q) => q.service === 'JTR<130')?.shippingCost).toBe(500000);
  });

  it('does NOT fabricate an ETD when JNE sends null', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    const q = (await provider.getRates(request())).find((x) => x.service === 'REG19')!;
    expect(q.estimatedDays).toBe('N/A');
    expect(q.providerMeta?.etd_from).toBeNull();
    expect(q.providerMeta?.etd_thru).toBeNull();
    expect(q.estimatedDays).not.toMatch(/\d/);
  });

  it('preserves an ETD when JNE provides one', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    const q = (await provider.getRates(request())).find((x) => x.service === 'JTR<130')!;
    expect(q.estimatedDays).toBe('3-4');
    expect(q.providerMeta?.etd_from).toBe('3');
    expect(q.providerMeta?.etd_thru).toBe('4');
  });

  it('collapses an identical ETD pair rather than printing "2-2"', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, JSON.stringify({ price: [{ service_code: 'REG', service_display: 'REG', price: '9000', etd_from: '2', etd_thru: '2' }] })));
    expect((await provider.getRates(request()))[0].estimatedDays).toBe('2');
  });

  it('carries the fields ShippingQuote cannot otherwise hold', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    const q = (await provider.getRates(request())).find((x) => x.service === 'JTR<130')!;
    expect(q.providerMeta).toEqual({
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

  it('drops rows with an unusable price or a missing service code', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(
      res(200, JSON.stringify({
        price: [
          { service_code: 'REG', service_display: 'REG', price: '9000' },
          { service_code: '', service_display: 'nameless', price: '9000' },
          { service_code: 'BAD', service_display: 'BAD', price: 'not-a-number' },
          { service_code: 'NEG', service_display: 'NEG', price: '-1' },
        ],
      })),
    );
    const quotes = await provider.getRates(request());
    expect(quotes).toHaveLength(1);
    expect(quotes[0].service).toBe('REG');
  });
});

describe('JNE errors never become quotes', () => {
  it('returns [] on {"status":false,"error":"Price Not Found."} — no fallback', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, JSON.stringify({ error: 'Price Not Found.', status: false })));
    await expect(provider.getRates(request())).resolves.toEqual([]);
  });

  it('returns [] on an error body even without status:false', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, JSON.stringify({ error: 'Invalid Api key' })));
    await expect(provider.getRates(request())).resolves.toEqual([]);
  });

  it('returns [] on malformed JSON', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, '<html>not json</html>'));
    await expect(provider.getRates(request())).resolves.toEqual([]);
  });

  it('returns [] on a well-formed body with no price array', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, JSON.stringify({ something_else: true })));
    await expect(provider.getRates(request())).resolves.toEqual([]);
  });

  it('returns [] on an empty price list', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, JSON.stringify({ price: [] })));
    await expect(provider.getRates(request())).resolves.toEqual([]);
  });

  it('propagates a 4xx as a permanent error rather than a quote', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(401, 'unauthorised'));
    await expect(provider.getRates(request())).rejects.toThrow();
  });

  it('propagates a timeout rather than falling back', async () => {
    const { provider, http } = build();
    http.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(provider.getRates(request())).rejects.toThrow();
  });
});

describe('RajaOngkir is parked, and mocks are gone', () => {
  it('never calls RajaOngkir, even though it is enabled in this config', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    await provider.getRates(request());
    for (const call of http.mock.calls) {
      expect(String(call[0])).not.toContain('rajaongkir');
      expect(String(call[0])).not.toContain('domestic-cost');
    }
  });

  it('does not read RajaOngkir village ids', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    await provider.getRates(request({ originRajaOngkirId: 111, destinationRajaOngkirId: 222 }));
    const body = String(http.mock.calls[0][1].body);
    expect(body).not.toContain('111');
    expect(body).not.toContain('222');
  });

  it('returns NO mock quote when JNE has no tariff, despite allowMockRates=true', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, JSON.stringify({ error: 'Price Not Found.', status: false })));
    const quotes = await provider.getRates(request());
    expect(quotes).toEqual([]);
    expect(JSON.stringify(quotes)).not.toContain('Mock');
  });

  it('returns [] rather than a mock when the courier is disabled', async () => {
    const { provider, http } = build(ANDIR, { enabled: false });
    await expect(provider.getRates(request())).resolves.toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });
});

describe('the environment guard applies to quotation too', () => {
  it('refuses to quote in production against the sandbox endpoint', async () => {
    const { provider, http } = build(ANDIR, { environment: 'production', baseUrl: SANDBOX_URL });
    await expect(provider.getRates(request())).rejects.toThrow(/known sandbox endpoint/);
    expect(http).not.toHaveBeenCalled();
  });
});
