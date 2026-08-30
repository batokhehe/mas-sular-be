import { Logger } from '@nestjs/common';
import { PermanentError, TransientError } from '../../src/modules/shipping/domain/shipping-errors';
import {
  executeShippingRequest,
  ShippingHttpClient,
  ShippingHttpResponse,
} from '../../src/modules/shipping/infrastructure/http/shipping-http-client';

/**
 * PAXELBOX-45A: HTTP 429 must cost exactly ONE request.
 *
 * A courier answering "too many requests" has already spent the quota; the old
 * client treated 429 exactly like a 5xx and retried it, so a single rate-limited
 * call consumed maxRetry+1 requests of the very quota that was exhausted
 * (RajaOngkir answers `{"meta":{"message":"Daily limit exceeded","code":429}}`).
 *
 * The 429 error CLASS is deliberately unchanged — still TransientError — so this
 * suite also pins that nothing about downstream classification moved.
 */

function res(status: number, body = ''): ShippingHttpResponse {
  return {
    status,
    text: async () => body,
    headers: { get: () => null },
  };
}

const logBase = { provider: 'test', origin: 'A', destination: 'B', service: 'ALL' };

function run(http: ShippingHttpClient, maxRetry: number) {
  return executeShippingRequest({
    http,
    url: 'https://courier.invalid/rates',
    init: { method: 'POST', headers: {}, body: '', timeoutMs: 1_000 },
    maxRetry,
    logger: new Logger('test'),
    logBase,
  });
}

describe('executeShippingRequest — 429 safety (PAXELBOX-45A)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('429 makes EXACTLY ONE HTTP attempt even with retries configured', async () => {
    const http = jest.fn().mockResolvedValue(res(429, '{"meta":{"message":"Daily limit exceeded","code":429}}'));

    await expect(run(http, 3)).rejects.toBeInstanceOf(TransientError);

    // The whole point: maxRetry=3 would previously have burned 4 requests.
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('429 stays classified as TransientError (classification unchanged)', async () => {
    const http = jest.fn().mockResolvedValue(res(429, 'rate limited'));

    await expect(run(http, 2)).rejects.toBeInstanceOf(TransientError);
    await expect(run(http, 2)).rejects.not.toBeInstanceOf(PermanentError);
  });

  it('429 error message carries the status and a truncated body', async () => {
    const http = jest.fn().mockResolvedValue(res(429, 'Daily limit exceeded'));

    await expect(run(http, 0)).rejects.toThrow('provider 429: Daily limit exceeded');
  });

  it('5xx is STILL retried — maxRetry+1 attempts (behaviour preserved)', async () => {
    const http = jest.fn().mockResolvedValue(res(503, 'upstream down'));

    await expect(run(http, 2)).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(3);
  });

  it('network/timeout errors are STILL retried (behaviour preserved)', async () => {
    const http = jest.fn().mockRejectedValue(new Error('AbortError'));

    await expect(run(http, 2)).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(3);
  });

  it('a 5xx that later succeeds still resolves (retry still works end to end)', async () => {
    const http = jest
      .fn()
      .mockResolvedValueOnce(res(500, 'boom'))
      .mockResolvedValueOnce(res(200, '{"ok":true}'));

    await expect(run(http, 2)).resolves.toEqual({ status: 200, text: '{"ok":true}' });
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('other 4xx remain PermanentError with no retry (behaviour preserved)', async () => {
    const http = jest.fn().mockResolvedValue(res(422, 'invalid'));

    await expect(run(http, 3)).rejects.toBeInstanceOf(PermanentError);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('2xx is returned unchanged on the first attempt', async () => {
    const http = jest.fn().mockResolvedValue(res(200, 'body'));

    await expect(run(http, 2)).resolves.toEqual({ status: 200, text: 'body' });
    expect(http).toHaveBeenCalledTimes(1);
  });
});
