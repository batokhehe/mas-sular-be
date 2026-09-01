/**
 * PAXELBOX-58: the production `AcquisitionTransport`.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `executeShippingRequest`
 *
 * The shipping client is the right tool for shipping and the wrong one here:
 * it imports `@nestjs/common`, which would drag the framework into an offline
 * prisma tool; it RETRIES (`maxRetry`), and acquisition must never retry,
 * because a retry against an unmeasured daily quota spends it to be told the
 * same thing; and it THROWS `PermanentError`/`TransientError` on a non-200,
 * which destroys the status code that `categorizeHttp` needs to tell a 429
 * apart from a 401. This transport therefore RETURNS every HTTP answer and
 * throws only when no answer arrived at all.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE KEY LIVES
 *
 * In this module's closure, and nowhere else. It is read from the environment
 * once, sent only in RajaOngkir's `key` header, and scrubbed from any error
 * this module raises. It never reaches the URL, the runner, the checkpoint, a
 * raw artifact or a log line — the runner is only ever handed a function.
 */

export const RAJAONGKIR_BASE_URL = 'https://rajaongkir.komerce.id/api/v1';
export const DOMESTIC_DESTINATION_PATH = '/destination/domestic-destination';

/** Mirrors `TransportResponse` in rajaongkir-acquisition.ts, kept structural to avoid a cycle. */
export interface HttpAnswer {
  status: number;
  body: unknown;
}

export interface TransportOptions {
  /** Overridden only by tests; production reads the real endpoint. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export class MissingApiKeyError extends Error {
  constructor() {
    super('RAJAONGKIR_API_KEY is not set');
    this.name = 'MissingApiKeyError';
  }
}

/**
 * Build the URL for one page. Exported so the plan builder and the tests use
 * the same construction, and so it can be asserted to carry no credential.
 */
export function destinationUrl(search: string, limit: number, offset: number, baseUrl = RAJAONGKIR_BASE_URL): string {
  const params = new URLSearchParams({
    // The API rejects a blank search with 422 (PAXELBOX-52E), so an empty term
    // is a programming error here rather than something to send and find out.
    search,
    limit: String(limit),
    offset: String(offset),
  });
  return `${baseUrl}${DOMESTIC_DESTINATION_PATH}?${params.toString()}`;
}

/** Remove a secret from anything about to be surfaced. Defence in depth. */
function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join('<redacted>') : text;
}

/**
 * Create the transport. Reading the key here — not inside the request — means
 * a missing key fails before a single request is made rather than after a
 * partial run has already spent quota on 400s.
 */
export function createRajaOngkirTransport(
  apiKey: string | undefined,
  options: TransportOptions = {},
): (url: string) => Promise<HttpAnswer> {
  if (!apiKey) throw new MissingApiKeyError();
  const key = apiKey;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function transport(url: string): Promise<HttpAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: 'GET',
        // The key travels ONLY here.
        headers: { key, accept: 'application/json' },
        // Manual: a redirect would re-issue the request, and a redirect to
        // another origin would carry the key header there.
        redirect: 'manual',
        signal: controller.signal,
      });

      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON. Returned as-is rather than thrown, so `validateEnvelope`
        // classifies it MALFORMED_RESPONSE with the status intact. An HTML
        // error page must not look like a network failure.
        body = { __nonJsonBody: scrub(text.slice(0, 500), key) };
      }

      // NOTE: every status is RETURNED, including 429/401/400. Classification
      // belongs to categorizeHttp, which needs the number to distinguish them.
      return { status: res.status, body };
    } catch (err) {
      // No HTTP answer at all — abort/DNS/TLS/socket. The runner turns this
      // into NETWORK_ERROR and stops; it does not retry.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`rajaongkir request failed: ${scrub(message, key)}`);
    } finally {
      clearTimeout(timer);
    }
  };
}
