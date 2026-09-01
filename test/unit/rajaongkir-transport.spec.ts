import { categorizeHttp } from '../../prisma/tools/rajaongkir-acquisition';
import {
  createRajaOngkirTransport,
  destinationUrl,
  MissingApiKeyError,
  DOMESTIC_DESTINATION_PATH,
  RAJAONGKIR_BASE_URL,
} from '../../prisma/tools/rajaongkir-transport';

/**
 * PAXELBOX-58. The real transport, exercised with an injected `fetch` — nothing
 * here reaches the network.
 *
 * Two properties matter most. The key must exist in exactly one place (the
 * `key` header) and leak into none. And every HTTP answer must be RETURNED, not
 * thrown: the runner needs the status number to tell a 429 (quota spent, stop
 * for the day) from a 401 (wrong credential) from a 400 (bad request). A
 * transport that throws on non-200 would flatten all three into one.
 */

const SECRET = 'test-key-must-never-leak-0123456789';
const okBody = { meta: { message: 'Success', code: 200, status: 'success' }, data: [] };

const jsonResponse = (status: number, body: unknown) =>
  ({ status, text: async () => JSON.stringify(body) }) as unknown as Response;

describe('destinationUrl', () => {
  it('builds a URL with search, limit and offset, and no credential', () => {
    const url = destinationUrl('Gedebage', 20, 40);
    expect(url.startsWith(`${RAJAONGKIR_BASE_URL}${DOMESTIC_DESTINATION_PATH}?`)).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('search')).toBe('Gedebage');
    expect(params.get('limit')).toBe('20');
    expect(params.get('offset')).toBe('40');
    expect(url).not.toContain(SECRET);
  });

  it('encodes search terms containing spaces', () => {
    const url = destinationUrl('Bandung Kulon', 20, 0);
    expect(new URL(url).searchParams.get('search')).toBe('Bandung Kulon');
  });
});

describe('authentication', () => {
  it('refuses to build a transport with no key, before any request', () => {
    expect(() => createRajaOngkirTransport(undefined)).toThrow(MissingApiKeyError);
    expect(() => createRajaOngkirTransport('')).toThrow(MissingApiKeyError);
  });

  it('sends the key in the `key` header only, never in the URL', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, okBody));
    const transport = createRajaOngkirTransport(SECRET, { fetchImpl: fetchImpl as never });

    await transport(destinationUrl('Gedebage', 20, 0));

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).not.toContain(SECRET);
    expect(init.headers.key).toBe(SECRET);
    expect(init.method).toBe('GET');
    // A redirect would re-issue the request and could carry the key elsewhere.
    expect(init.redirect).toBe('manual');
  });
});

describe('HTTP answers are returned, never thrown', () => {
  it.each([
    [429, 'RATE_LIMITED'],
    [401, 'AUTHENTICATION_FAILED'],
    [403, 'AUTHENTICATION_FAILED'],
    [400, 'HTTP_ERROR'],
    [500, 'HTTP_ERROR'],
  ])('status %i is returned and categorizes as %s', async (status, expected) => {
    const body = { meta: { message: 'nope', code: status, status: 'failed' }, data: null };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(status, body));
    const transport = createRajaOngkirTransport(SECRET, { fetchImpl: fetchImpl as never });

    const answer = await transport('https://ro.test/x');

    expect(answer.status).toBe(status);
    expect(answer.body).toEqual(body);
    expect(categorizeHttp(answer.status)).toBe(expected);
  });

  it('makes exactly one request for a 429 — the transport never retries', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(429, { meta: { message: 'Daily limit exceeded', code: 429 }, data: null }));
    const transport = createRajaOngkirTransport(SECRET, { fetchImpl: fetchImpl as never });

    await transport('https://ro.test/x');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves a 400 API message so the operator sees what RajaOngkir said', async () => {
    const body = { meta: { message: 'Invalid Api key, key not found', code: 400, status: 'failed' }, data: null };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(400, body));
    const transport = createRajaOngkirTransport(SECRET, { fetchImpl: fetchImpl as never });

    const answer = await transport('https://ro.test/x');

    expect((answer.body as typeof body).meta.message).toBe('Invalid Api key, key not found');
  });

  it('returns a non-JSON body with its status intact instead of throwing', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue({ status: 502, text: async () => '<html>bad gateway</html>' } as unknown as Response);
    const transport = createRajaOngkirTransport(SECRET, { fetchImpl: fetchImpl as never });

    const answer = await transport('https://ro.test/x');

    // Status survives, so this is an HTTP_ERROR — not mistaken for a network fault.
    expect(answer.status).toBe(502);
    expect(categorizeHttp(answer.status)).toBe('HTTP_ERROR');
    expect(JSON.stringify(answer.body)).toContain('bad gateway');
  });
});

describe('network failures', () => {
  it('throws when no HTTP answer arrives at all', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const transport = createRajaOngkirTransport(SECRET, { fetchImpl: fetchImpl as never });

    await expect(transport('https://ro.test/x')).rejects.toThrow(/ECONNRESET/);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still no retry
  });

  it('scrubs the key out of a network error message', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error(`connect failed using key ${SECRET}`));
    const transport = createRajaOngkirTransport(SECRET, { fetchImpl: fetchImpl as never });

    await expect(transport('https://ro.test/x')).rejects.toThrow(/<redacted>/);
    await expect(transport('https://ro.test/x')).rejects.not.toThrow(new RegExp(SECRET));
  });

  it('scrubs the key out of a non-JSON body echoed back by a server', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue({ status: 500, text: async () => `error for key=${SECRET}` } as unknown as Response);
    const transport = createRajaOngkirTransport(SECRET, { fetchImpl: fetchImpl as never });

    const answer = await transport('https://ro.test/x');

    expect(JSON.stringify(answer.body)).not.toContain(SECRET);
    expect(JSON.stringify(answer.body)).toContain('<redacted>');
  });
});
