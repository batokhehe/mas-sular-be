import { JneProvider } from '../../src/modules/shipping/infrastructure/providers/jne.provider';
import { PermanentError, TransientError } from '../../src/modules/shipping/domain/shipping-errors';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';

function config(enabled = true, maxRetry = 1, allowMockRates = false): ShippingConfig {
  return {
    originPostalCode: '40111',
    allowMockRates,
    paxel: { enabled: false, baseUrl: 'https://paxel.test', timeoutMs: 500, maxRetry, defaultDimension: '30x35x20', needInsurance: false },
    jne: {
      enabled,
      baseUrl: 'https://jne.test',
      apiKey: 'secret-key',
      username: 'store',
      originCode: 'BDO10000',
      timeoutMs: 500,
      maxRetry,
    },
  };
}

function res(status: number, body: string): ShippingHttpResponse {
  return { status, text: async () => body, headers: { get: () => null } };
}

const request = { originPostalCode: '40111', destinationPostalCode: '40131', weightGram: 1500 };

const OK_BODY = JSON.stringify({
  price: [
    { service_code: 'REG', service_display: 'Regular', price: 13000, etd_from: '2', etd_thru: '3' },
    { service_code: 'YES', service_display: 'YES', price: '22000', etd_from: '1', etd_thru: '1' },
  ],
});

function build(cfg = config()) {
  const provider = new JneProvider(cfg);
  const http = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).http = http;
  return { provider, http };
}

describe('JneProvider', () => {
  it('maps a successful tariff response to ShippingQuote[]', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));

    const quotes = await provider.getRates(request);

    expect(quotes).toEqual([
      { provider: 'jne', service: 'REG', serviceName: 'JNE Regular', estimatedDays: '2-3 Days', shippingCost: 13000 },
      { provider: 'jne', service: 'YES', serviceName: 'JNE YES', estimatedDays: '1 Days', shippingCost: 22000 },
    ]);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('authenticates via form body and uses the configured origin code', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    await provider.getRates(request);
    const [, init] = http.mock.calls[0];
    const body = String(init.body);
    expect(body).toContain('api_key=secret-key');
    expect(body).toContain('username=store');
    expect(body).toContain('from=BDO10000');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('returns [] when disabled and mocks are not allowed (no HTTP call)', async () => {
    const { provider, http } = build(config(false));
    expect(await provider.getRates(request)).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('returns mock quotes when disabled and mocks are allowed (no HTTP call)', async () => {
    const { provider, http } = build(config(false, 1, true));
    const quotes = await provider.getRates(request);
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every((q) => q.provider === 'jne' && q.serviceName.includes('Mock'))).toBe(true);
    expect(http).not.toHaveBeenCalled();
  });

  it('classifies HTTP 4xx as PermanentError (no retry)', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(422, 'invalid'));
    await expect(provider.getRates(request)).rejects.toBeInstanceOf(PermanentError);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('classifies HTTP 5xx as TransientError and retries', async () => {
    const { provider, http } = build(config(true, 1));
    http.mockResolvedValue(res(500, 'boom'));
    await expect(provider.getRates(request)).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('classifies a network/timeout error as TransientError and retries', async () => {
    const { provider, http } = build(config(true, 2));
    http.mockRejectedValue(new Error('AbortError'));
    await expect(provider.getRates(request)).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(3);
  });
});
