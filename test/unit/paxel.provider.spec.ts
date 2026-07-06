import { PaxelProvider } from '../../src/modules/shipping/infrastructure/providers/paxel.provider';
import { PermanentError, TransientError } from '../../src/modules/shipping/domain/shipping-errors';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';

function config(enabled = true, maxRetry = 1, allowMockRates = false): ShippingConfig {
  return {
    originPostalCode: '40111',
    allowMockRates,
    paxel: { enabled, baseUrl: 'https://api.paxel.test', apiKey: 'secret-key', timeoutMs: 500, maxRetry },
    jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry },
  };
}

function res(status: number, body: string): ShippingHttpResponse {
  return { status, text: async () => body, headers: { get: () => null } };
}

const request = { originPostalCode: '40111', destinationPostalCode: '40131', weightGram: 1500 };

const OK_BODY = JSON.stringify({
  data: {
    services: [
      { service_type: 'SAME_DAY', service_name: 'Paxel Same Day', price: 18000, estimated_delivery: 'Today' },
    ],
  },
});

function build(cfg = config()) {
  const provider = new PaxelProvider(cfg);
  const http = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).http = http;
  return { provider, http };
}

describe('PaxelProvider', () => {
  it('maps a successful response to ShippingQuote[]', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));

    const quotes = await provider.getRates(request);

    expect(quotes).toEqual([
      { provider: 'paxel', service: 'SAME_DAY', serviceName: 'Paxel Same Day', estimatedDays: 'Today', shippingCost: 18000 },
    ]);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('sends a Bearer credential and never returns raw provider fields', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, OK_BODY));
    await provider.getRates(request);
    const [, init] = http.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer secret-key');
  });

  it('returns [] when disabled and mocks are not allowed (no HTTP call)', async () => {
    const { provider, http } = build(config(false));
    const quotes = await provider.getRates(request);
    expect(quotes).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('returns mock quotes when disabled and mocks are allowed (no HTTP call)', async () => {
    const { provider, http } = build(config(false, 1, true));
    const quotes = await provider.getRates(request);
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every((q) => q.provider === 'paxel' && q.serviceName.includes('Mock'))).toBe(true);
    expect(http).not.toHaveBeenCalled();
  });

  it('classifies HTTP 4xx as PermanentError (no retry)', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(400, 'bad request'));
    await expect(provider.getRates(request)).rejects.toBeInstanceOf(PermanentError);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('classifies HTTP 5xx as TransientError and retries', async () => {
    const { provider, http } = build(config(true, 1)); // 1 retry → 2 attempts
    http.mockResolvedValue(res(503, 'unavailable'));
    await expect(provider.getRates(request)).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('classifies a network/timeout error as TransientError and retries', async () => {
    const { provider, http } = build(config(true, 2)); // 2 retries → 3 attempts
    http.mockRejectedValue(new Error('AbortError'));
    await expect(provider.getRates(request)).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(3);
  });
});
