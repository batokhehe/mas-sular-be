import { PaxelProvider } from '../../src/modules/shipping/infrastructure/providers/paxel.provider';
import { paxelServiceSpec, PAXEL_SERVICES } from '../../src/modules/shipping/infrastructure/providers/paxel-rate.map';
import { isPaxelDimension, ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpRequest, ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import { ShippingRateRequest } from '../../src/modules/shipping/domain/shipping-provider.interface';

/**
 * Paxel rate integration, tested against the contract in the Paxel eCommerce API
 * Postman collection rather than an assumed one.
 *
 * The previous implementation was written against a guessed API — Bearer auth,
 * `/v1/rates`, and a `data.services[].price` response field that Paxel does not
 * return — so it could never have produced a quote in production. These tests
 * pin the parts the collection actually specifies: per-service endpoints, the
 * X-Paxel-API-Key header, the address block, and `fixed_price`.
 */

const API_KEY = 'test-api-key-not-a-real-secret';

function config(over: Partial<{ enabled: boolean; maxRetry: number; allowMockRates: boolean; dimension: string }> = {}): ShippingConfig {
  return {
    originPostalCode: '40111',
    allowMockRates: over.allowMockRates ?? false,
    paxel: {
      enabled: over.enabled ?? true,
      baseUrl: 'https://stage-commerce-api.paxel.test/v1',
      apiKey: API_KEY,
      timeoutMs: 500,
      maxRetry: over.maxRetry ?? 0,
      defaultDimension: over.dimension ?? '30x35x20', needInsurance: false,
    },
    jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry: 0, },
  };
}

function res(status: number, body: string): ShippingHttpResponse {
  return { status, text: async () => body, headers: { get: () => null } };
}

/** A rate response shaped like the collection's saved examples. */
function okBody(fixedPrice: unknown = 20000): string {
  return JSON.stringify({
    status_code: 200,
    message: 'OK',
    data: {
      response_code: 0,
      city_origin: 'KOTA BANDUNG',
      city_destination: 'KOTA JAKARTA UTARA',
      small_price: 14000,
      medium_price: 18000,
      large_price: 20000,
      custom_price: 20000,
      fixed_price: fixedPrice,
      fixed_price_type: 'dimension',
      fixed_size: 'large',
      time_detail: [{ time_delivery_start: '18:00:00', time_delivery_end: '22:00:00' }],
    },
  });
}

/** A complete domain request: every field Paxel marks required is present. */
const completeRequest: ShippingRateRequest = {
  originPostalCode: '40111',
  destinationPostalCode: '14270',
  weightGram: 1500,
  originLatitude: -6.9,
  originLongitude: 107.6,
  destinationLatitude: -6.117664,
  destinationLongitude: 106.906349,
  originName: 'Outlet Bandung',
  originAddress: 'Jl. Outlet No.1',
  originProvince: 'Jawa Barat',
  originCity: 'Kota Bandung',
  originDistrict: 'Coblong',
  originVillage: 'Dago',
  destinationAddress: 'Muara Karang Blok 7',
  destinationProvince: 'DKI Jakarta',
  destinationCity: 'Kota Jakarta Utara',
  destinationDistrict: 'Koja',
  destinationVillage: 'Pluit',
};

interface Call {
  url: string;
  init: ShippingHttpRequest;
}

/** Captures every outgoing HTTP call so the real request body can be asserted. */
function build(cfg = config(), responder: (call: Call) => ShippingHttpResponse = () => res(200, okBody())) {
  const calls: Call[] = [];
  const provider = new PaxelProvider(cfg);
  const http = async (url: string, init: ShippingHttpRequest) => {
    calls.push({ url, init });
    return responder({ url, init });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).http = http;
  return { provider, calls };
}

function bodyOf(call: Call) {
  return JSON.parse(call.init.body as string);
}

function callFor(calls: Call[], serviceType: string) {
  return calls.find((c) => bodyOf(c).service_type === serviceType);
}

// ============================================================ service mapping ==

describe('Paxel service mapping', () => {
  it.each([
    ['PAXEL_INSTANT', '/rates/instant', 'INSTANT GOSEND', 25_000],
    ['PAXEL_SAMEDAY', '/rates/city', 'SAMEDAY', 5_000],
    ['PAXEL_NEXTDAY', '/rates/city', 'NEXTDAY', 5_000],
    ['PAXEL_REGULAR', '/rates/city', 'REGULAR', 5_000],
  ] as const)('%s maps to %s with service_type %s', (service, path, serviceType, maxWeight) => {
    const spec = paxelServiceSpec(service);
    expect(spec.path).toBe(path);
    expect(spec.serviceType).toBe(serviceType);
    expect(spec.maxWeightGram).toBe(maxWeight);
  });

  it('supports exactly the four approved services', () => {
    expect([...PAXEL_SERVICES]).toEqual(['PAXEL_INSTANT', 'PAXEL_SAMEDAY', 'PAXEL_NEXTDAY', 'PAXEL_REGULAR']);
  });
});

// =============================================================== the request ==

describe('Paxel rate request', () => {
  it('quotes every service, INSTANT on its own endpoint and the rest on /rates/city', async () => {
    const { provider, calls } = build();
    await provider.getRates(completeRequest);

    expect(calls).toHaveLength(4);
    const instant = callFor(calls, 'INSTANT GOSEND')!;
    expect(instant.url).toBe('https://stage-commerce-api.paxel.test/v1/rates/instant');
    for (const serviceType of ['SAMEDAY', 'NEXTDAY', 'REGULAR']) {
      expect(callFor(calls, serviceType)!.url).toBe('https://stage-commerce-api.paxel.test/v1/rates/city');
    }
  });

  it('authenticates with X-Paxel-API-Key and never with Bearer', async () => {
    const { provider, calls } = build();
    await provider.getRates(completeRequest);

    for (const call of calls) {
      expect(call.init.headers['X-Paxel-API-Key']).toBe(API_KEY);
      expect(call.init.headers.Authorization).toBeUndefined();
      expect(JSON.stringify(call.init.headers)).not.toMatch(/Bearer/i);
      expect(call.init.method).toBe('POST');
      expect(call.init.headers['Content-Type']).toBe('application/json');
    }
  });

  it('sends the documented address block, names not ids', async () => {
    const { provider, calls } = build();
    await provider.getRates(completeRequest);
    const body = bodyOf(callFor(calls, 'SAMEDAY')!);

    expect(body.destination).toEqual({
      address: 'Muara Karang Blok 7',
      province: 'DKI Jakarta',
      city: 'Kota Jakarta Utara',
      district: 'Koja',
      village: 'Pluit',
      zip_code: '14270',
      latitude: -6.117664,
      longitude: 106.906349,
    });
    expect(body.origin.city).toBe('Kota Bandung');
    expect(body.origin.district).toBe('Coblong');
  });

  it('omits optional address keys that have no value rather than sending blanks', async () => {
    const { provider, calls } = build();
    await provider.getRates({ ...completeRequest, destinationVillage: undefined, destinationLatitude: undefined, destinationLongitude: undefined });
    const destination = bodyOf(callFor(calls, 'SAMEDAY')!).destination;

    expect(destination).not.toHaveProperty('village');
    expect(destination).not.toHaveProperty('latitude');
    expect(destination).not.toHaveProperty('longitude');
    expect(destination.zip_code).toBe('14270');
  });

  it('sends the configured dimension, never a literal', async () => {
    const { provider, calls } = build(config({ dimension: '20x20x20' }));
    await provider.getRates(completeRequest);
    for (const call of calls) {
      expect(bodyOf(call).dimension).toBe('20x20x20');
    }
  });

  it('sends weight in grams, unchanged from the domain request', async () => {
    const { provider, calls } = build();
    await provider.getRates({ ...completeRequest, weightGram: 2500 });
    expect(bodyOf(callFor(calls, 'SAMEDAY')!).weight).toBe(2500);
  });
});

// ================================================================ weight caps ==

describe('Paxel weight limits', () => {
  it('rejects a parcel over the city cap but still quotes INSTANT (cap 25000g)', async () => {
    const { provider, calls } = build();
    const quotes = await provider.getRates({ ...completeRequest, weightGram: 6000 });

    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]).service_type).toBe('INSTANT GOSEND');
    expect(quotes.map((q) => q.service)).toEqual(['PAXEL_INSTANT']);
  });

  it('makes no call at all when the parcel exceeds every service cap', async () => {
    const { provider, calls } = build();
    const quotes = await provider.getRates({ ...completeRequest, weightGram: 26_000 });
    expect(calls).toHaveLength(0);
    expect(quotes).toEqual([]);
  });

  it('rejects a zero/negative weight rather than sending an invalid request', async () => {
    const { provider, calls } = build();
    expect(await provider.getRates({ ...completeRequest, weightGram: 0 })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ========================================================= address validation ==

describe('Paxel required address validation', () => {
  it.each(['destinationAddress', 'destinationProvince', 'destinationCity', 'destinationDistrict', 'originCity', 'originDistrict'] as const)(
    'makes NO HTTP call when %s is missing',
    async (field) => {
      const { provider, calls } = build();
      const quotes = await provider.getRates({ ...completeRequest, [field]: undefined });
      expect(calls).toHaveLength(0);
      expect(quotes).toEqual([]);
    },
  );

  it('never substitutes a postal code for a missing city name', async () => {
    const { provider, calls } = build();
    await provider.getRates({ ...completeRequest, destinationCity: undefined });
    expect(calls).toHaveLength(0);
  });
});

// ============================================================== the response ==

describe('Paxel response normalization', () => {
  it('normalizes data.fixed_price into shippingCost', async () => {
    const { provider } = build();
    const quotes = await provider.getRates(completeRequest);

    expect(quotes).toHaveLength(4);
    const sameday = quotes.find((q) => q.service === 'PAXEL_SAMEDAY')!;
    expect(sameday).toEqual({
      provider: 'paxel',
      service: 'PAXEL_SAMEDAY',
      serviceName: 'Paxel Same Day',
      estimatedDays: '18:00-22:00',
      shippingCost: 20000,
    });
  });

  it('never falls back to small/medium/large/custom_price when fixed_price is missing', async () => {
    const { provider } = build(config(), () =>
      res(200, JSON.stringify({ data: { small_price: 14000, medium_price: 18000, large_price: 20000, custom_price: 20000 } })),
    );
    expect(await provider.getRates(completeRequest)).toEqual([]);
  });

  it.each([[null], [0], ['20000'], [-5]])('treats fixed_price %p as unusable rather than quoting it', async (value) => {
    const { provider } = build(config(), () => res(200, okBody(value)));
    expect(await provider.getRates(completeRequest)).toEqual([]);
  });

  it('fails safely on a malformed body', async () => {
    const { provider } = build(config(), () => res(200, 'not-json'));
    expect(await provider.getRates(completeRequest)).toEqual([]);
  });
});

// ============================================================ error handling ==

describe('Paxel error handling', () => {
  it('drops a 4xx service without failing the others', async () => {
    const { provider } = build(config(), (call) =>
      bodyOf(call).service_type === 'SAMEDAY' ? res(400, '{"message":"bad request"}') : res(200, okBody()),
    );
    const quotes = await provider.getRates(completeRequest);
    expect(quotes.map((q) => q.service).sort()).toEqual(['PAXEL_INSTANT', 'PAXEL_NEXTDAY', 'PAXEL_REGULAR']);
  });

  it('drops an unauthorized service (401/403) without quoting it', async () => {
    const { provider } = build(config(), () => res(401, '{"message":"unauthorized"}'));
    expect(await provider.getRates(completeRequest)).toEqual([]);
  });

  it('retries a 5xx and yields no quote when it keeps failing', async () => {
    const calls: string[] = [];
    const { provider } = build(config({ maxRetry: 1 }), (call) => {
      calls.push(bodyOf(call).service_type);
      return res(503, 'upstream down');
    });
    expect(await provider.getRates(completeRequest)).toEqual([]);
    // 4 services x (1 attempt + 1 retry)
    expect(calls).toHaveLength(8);
  });

  it('treats a network/timeout failure as retryable and yields no quote', async () => {
    const provider = new PaxelProvider(config({ maxRetry: 1 }));
    let attempts = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).http = async () => {
      attempts += 1;
      throw new Error('AbortError');
    };
    expect(await provider.getRates(completeRequest)).toEqual([]);
    expect(attempts).toBe(8);
  });
});

// ================================================================== disabled ==

describe('Paxel disabled', () => {
  it('makes no HTTP call and returns nothing when disabled without mocks', async () => {
    const { provider, calls } = build(config({ enabled: false }));
    expect(await provider.getRates(completeRequest)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns clearly-labeled mock quotes when disabled and mocks are allowed, still with no HTTP call', async () => {
    const { provider, calls } = build(config({ enabled: false, allowMockRates: true }));
    const quotes = await provider.getRates(completeRequest);
    expect(calls).toHaveLength(0);
    expect(quotes.every((q) => q.serviceName.includes('Mock'))).toBe(true);
  });
});

// ================================================================== security ==

describe('Paxel credential safety', () => {
  it('keeps the API key out of thrown errors and log arguments', async () => {
    const logged: unknown[] = [];
    const { provider } = build(config(), () => res(400, '{"message":"bad request"}'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logger = (provider as any).logger;
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }

    await provider.getRates(completeRequest);

    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(API_KEY);
    expect(JSON.stringify(logged)).not.toMatch(/X-Paxel-API-Key/i);
    // The street address is customer data and must not be logged either.
    expect(JSON.stringify(logged)).not.toContain('Muara Karang Blok 7');
    jest.restoreAllMocks();
  });
});

// ============================================================ config validity ==

describe('PAXEL_DEFAULT_DIMENSION validation', () => {
  it.each(['30x35x20', '1x1x1', '50x50x50'])('accepts %s', (value) => {
    expect(isPaxelDimension(value)).toBe(true);
  });

  it.each(['', undefined, '30x35', '30-35-20', '0x1x1', '51x10x10', '30x35x20cm'])('rejects %p', (value) => {
    expect(isPaxelDimension(value as string | undefined)).toBe(false);
  });
});
