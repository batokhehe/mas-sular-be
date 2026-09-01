import { JneProvider } from '../../src/modules/shipping/infrastructure/providers/jne.provider';
import { PermanentError, TransientError } from '../../src/modules/shipping/domain/shipping-errors';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';

/**
 * PAXELBOX-45: JNE quotation is now sourced from RajaOngkir.
 *
 * RajaOngkir is a RATE SOURCE, not a courier. The provider name, the quotes and
 * the resulting order all still say `jne`; nothing downstream learns the price
 * came from a third party. `track()` is unchanged and still talks to JNE.
 *
 * These replace the previous direct-JNE-tariff rate cases (that endpoint is no
 * longer called) and keep the intent of every one of them: mapping, request
 * shape, disabled/mock behaviour, and error classification.
 */

function config(
  enabled = true,
  maxRetry = 1,
  allowMockRates = false,
): ShippingConfig {
  return {
    originPostalCode: '40111',
    allowMockRates,
    paxel: { enabled: false, baseUrl: 'https://paxel.test', timeoutMs: 500, maxRetry, defaultDimension: '30x35x20', needInsurance: false },
    jne: {
      enabled: true,
      baseUrl: 'https://jne.test',
      apiKey: 'secret-key',
      username: 'store',
      originCode: 'BDO10000',
      timeoutMs: 500,
      maxRetry,
    },
    // The RATE source. `enabled` here — not jne.enabled — gates quotation.
    rajaongkir: { enabled, baseUrl: 'https://rajaongkir.test/api/v1', apiKey: 'ro-secret', timeoutMs: 500, maxRetry },
  };
}

function res(status: number, body: string): ShippingHttpResponse {
  return { status, text: async () => body, headers: { get: () => null } };
}

/** A request carrying resolved RajaOngkir district ids (the future normal case). */
const request = {
  originPostalCode: '40111',
  destinationPostalCode: '40131',
  weightGram: 1500,
  originRajaOngkirId: 501,
  destinationRajaOngkirId: 1361,
};

const OK_BODY = JSON.stringify({
  meta: { message: 'Success Calculate Domestic Shipping cost', code: 200, status: 'success' },
  data: [
    { name: 'Jalur Nugraha Ekakurir (JNE)', code: 'jne', service: 'REG', description: 'Layanan Reguler', cost: 13000, etd: '2-3 day' },
    { name: 'Jalur Nugraha Ekakurir (JNE)', code: 'jne', service: 'YES', description: 'Yakin Esok Sampai', cost: '22000', etd: '1 day' },
  ],
});

function build(cfg = config()) {
  const provider = new JneProvider(cfg);
  const http = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).http = http;
  return { provider, http };
}

const bodyOf = (http: jest.Mock) => new URLSearchParams(String(http.mock.calls[0][1].body));

// ------------------------------------------------------------- identity

describe('provider identity is unchanged', () => {
  it('is still named "jne" — never "rajaongkir"', () => {
    const { provider } = build();

    expect(provider.name).toBe('jne');
  });

  it('labels its quotes as jne', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));

    const quotes = await provider.getRates(request);

    expect(quotes.every((q) => q.provider === 'jne')).toBe(true);
  });
});

// -------------------------------------------------------- request shape

describe('the RajaOngkir cost request', () => {
  it('POSTs form-urlencoded to /calculate/domestic-cost', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));

    await provider.getRates(request);

    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][0]).toBe('https://rajaongkir.test/api/v1/calculate/domestic-cost');
    expect(http.mock.calls[0][1].method).toBe('POST');
    expect(http.mock.calls[0][1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('sends courier=jne and price=lowest', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));

    await provider.getRates(request);

    expect(bodyOf(http).get('courier')).toBe('jne');
    expect(bodyOf(http).get('price')).toBe('lowest');
  });

  it('passes origin and destination through as RajaOngkir district ids', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));

    await provider.getRates(request);

    expect(bodyOf(http).get('origin')).toBe('501');
    expect(bodyOf(http).get('destination')).toBe('1361');
  });

  it('sends weight in GRAMS, with no kilogram rounding', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));

    await provider.getRates({ ...request, weightGram: 1200 });

    // The replaced JNE tariff call rounded 1200 g up to 2 kg; RajaOngkir takes
    // grams natively, so the customer is priced for what they actually ordered.
    expect(bodyOf(http).get('weight')).toBe('1200');
  });

  it('carries the API key in the `key` header, never in the body or URL', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));

    await provider.getRates(request);

    expect(http.mock.calls[0][1].headers.key).toBe('ro-secret');
    expect(String(http.mock.calls[0][1].body)).not.toContain('ro-secret');
    expect(String(http.mock.calls[0][0])).not.toContain('ro-secret');
  });

  it('sends no dimensions — the contract has no such field', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));

    await provider.getRates(request);

    const keys = [...bodyOf(http).keys()].sort();
    expect(keys).toEqual(['courier', 'destination', 'origin', 'price', 'weight']);
  });
});

// ------------------------------------------------- missing district ids

describe('an unmapped address yields no quote, never a guess', () => {
  it('makes NO HTTP call when the destination id is absent', async () => {
    const { provider, http } = build();

    const quotes = await provider.getRates({ ...request, destinationRajaOngkirId: undefined });

    expect(quotes).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('makes NO HTTP call when the origin id is absent', async () => {
    const { provider, http } = build();

    const quotes = await provider.getRates({ ...request, originRajaOngkirId: undefined });

    expect(quotes).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('never substitutes a postal code for a district id', async () => {
    const { provider, http } = build();

    await provider.getRates({ ...request, originRajaOngkirId: undefined, destinationRajaOngkirId: undefined });

    // Postal codes are present on the request and must stay unused: a wrong
    // district silently misprices an order the customer then pays.
    expect(http).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------- mapping

describe('response mapping', () => {
  it('maps a successful response to ShippingQuote[]', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));

    const quotes = await provider.getRates(request);

    expect(quotes).toEqual([
      { provider: 'jne', service: 'REG', serviceName: 'JNE Layanan Reguler', estimatedDays: '2-3 day', shippingCost: 13000 },
      { provider: 'jne', service: 'YES', serviceName: 'JNE Yakin Esok Sampai', estimatedDays: '1 day', shippingCost: 22000 },
    ]);
  });

  it('returns [] when meta reports a non-200 envelope', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, JSON.stringify({ meta: { code: 400, status: 'error', message: 'bad request' }, data: [] })));

    await expect(provider.getRates(request)).resolves.toEqual([]);
  });

  it('returns [] on a malformed body rather than a fabricated quote', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, '<html>not json</html>'));

    await expect(provider.getRates(request)).resolves.toEqual([]);
  });

  it('drops rows with an unusable cost or a missing service', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, JSON.stringify({
      meta: { code: 200 },
      data: [
        { code: 'jne', service: 'REG', description: 'Reguler', cost: 'not-a-number', etd: '2 day' },
        { code: 'jne', service: '', description: 'No service code', cost: 9000, etd: '2 day' },
        { code: 'jne', service: 'OKE', description: 'Ekonomis', cost: 9000, etd: '3 day' },
      ],
    })));

    const quotes = await provider.getRates(request);

    expect(quotes).toEqual([
      { provider: 'jne', service: 'OKE', serviceName: 'JNE Ekonomis', estimatedDays: '3 day', shippingCost: 9000 },
    ]);
  });

  it('filters out any courier that is not jne', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, JSON.stringify({
      meta: { code: 200 },
      data: [
        { code: 'sicepat', service: 'BEST', description: 'Besok Sampai', cost: 11000, etd: '1 day' },
        { code: 'jne', service: 'REG', description: 'Reguler', cost: 13000, etd: '2 day' },
      ],
    })));

    const quotes = await provider.getRates(request);

    expect(quotes.map((q) => q.service)).toEqual(['REG']);
  });

  it('falls back to the service code when no description is given', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, JSON.stringify({ meta: { code: 200 }, data: [{ code: 'jne', service: 'REG', cost: 13000 }] })));

    const quotes = await provider.getRates(request);

    expect(quotes[0].serviceName).toBe('JNE REG');
    expect(quotes[0].estimatedDays).toBe('N/A');
  });
});

// ----------------------------------------------------- disabled / mocks

describe('disabled and mock behaviour', () => {
  it('returns [] when RajaOngkir is disabled and mocks are not allowed (no HTTP call)', async () => {
    const { provider, http } = build(config(false, 1, false));

    await expect(provider.getRates(request)).resolves.toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('returns clearly-labelled mock quotes when disabled and mocks are allowed (no HTTP call)', async () => {
    const { provider, http } = build(config(false, 1, true));

    const quotes = await provider.getRates(request);

    expect(http).not.toHaveBeenCalled();
    expect(quotes.length).toBeGreaterThan(0);
    // Every mock says so in its own name — a mock price can never be mistaken
    // for a real RajaOngkir quote in checkout or in a support conversation.
    expect(quotes.every((q) => /\(Mock\)/.test(q.serviceName))).toBe(true);
  });

  it('never produces a mock while RajaOngkir is enabled', async () => {
    const { provider, http } = build(config(true, 1, true));
    http.mockResolvedValue(res(200, OK_BODY));

    const quotes = await provider.getRates(request);

    expect(quotes.every((q) => !/\(Mock\)/.test(q.serviceName))).toBe(true);
  });
});

// ------------------------------------------------- error classification

describe('error classification is unchanged', () => {
  it('classifies HTTP 4xx as PermanentError (no retry)', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(400, '{"meta":{"code":400}}'));

    await expect(provider.getRates(request)).rejects.toBeInstanceOf(PermanentError);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('classifies HTTP 429 as TransientError and does NOT retry (daily quota)', async () => {
    const { provider, http } = build(config(true, 3));
    http.mockResolvedValue(res(429, '{"meta":{"message":"Daily limit exceeded","code":429,"status":"error"}}'));

    await expect(provider.getRates(request)).rejects.toBeInstanceOf(TransientError);
    // PAXELBOX-45A: retrying spends more of the same exhausted daily quota.
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('produces no quote from a 429 — never a fabricated or stale price', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(429, '{"meta":{"message":"Daily limit exceeded","code":429}}'));

    await expect(provider.getRates(request)).rejects.toThrow();
    // The rejection is what ShippingService isolates; no value escapes.
  });

  it('classifies HTTP 5xx as TransientError and retries', async () => {
    // maxRetry counts retries BEYOND the first attempt: 1 => 2 calls total.
    const { provider, http } = build(config(true, 1));
    http.mockResolvedValue(res(503, 'upstream down'));

    await expect(provider.getRates(request)).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('classifies a network/timeout error as TransientError and retries', async () => {
    const { provider, http } = build(config(true, 1));
    http.mockRejectedValue(new Error('socket hang up'));

    await expect(provider.getRates(request)).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(2);
  });
});
