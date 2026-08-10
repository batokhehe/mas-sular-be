import { Logger } from '@nestjs/common';
import { PermanentGatewayError, TransientGatewayError } from '../../domain/payment-gateway-errors';

/** Exactly the HTTP statuses worth repeating — everything else is a decision, not a glitch. */
export const RETRYABLE_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

export interface MidtransHttpResponse {
  status: number;
  text(): Promise<string>;
}

export interface MidtransHttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export type MidtransHttpClient = (url: string, init: MidtransHttpRequest) => Promise<MidtransHttpResponse>;

/** Real transport: fetch + AbortController timeout. Swapped for a stub in tests. */
export const defaultMidtransHttpClient: MidtransHttpClient = async (url, init) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const controller = new g.AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    return await g.fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};

export interface MidtransRequestOptions {
  http: MidtransHttpClient;
  url: string;
  init: MidtransHttpRequest;
  maxRetry: number;
  logger: Logger;
  /** Secret-free correlation fields for the structured log. */
  logBase: Record<string, unknown>;
}

function sanitize(text: string): string {
  return text.slice(0, 300);
}

/**
 * Execute a Midtrans request with timeout, bounded retry, and error
 * classification. Returns the parsed JSON body on success.
 *
 * Retries are safe because every call carries a stable `X-Idempotency-Key` AND a
 * per-attempt `order_id`: Midtrans rejects a duplicate order_id outright (406),
 * so a repeated charge can never double-bill. Logs deliberately carry no keys,
 * card data, or customer PII.
 */
export async function executeMidtransRequest<T>(opts: MidtransRequestOptions): Promise<T> {
  const { http, url, init, maxRetry, logger, logBase } = opts;
  const attempts = Math.max(1, maxRetry + 1);
  const startedAt = Date.now();
  let lastTransient: TransientGatewayError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res: MidtransHttpResponse;
    try {
      res = await http(url, init);
    } catch (err) {
      // AbortError (timeout) and network failures land here — retryable.
      const reason = err instanceof Error ? err.message : String(err);
      lastTransient = new TransientGatewayError(`network error: ${reason}`, 'midtrans');
      logger.warn({ ...logBase, attempt, outcome: 'retry', errorClass: 'network', elapsedMs: Date.now() - startedAt });
      continue;
    }

    const text = await res.text().catch(() => '');

    if (res.status >= 200 && res.status < 300) {
      logger.log({ ...logBase, attempt, outcome: 'ok', status: res.status, elapsedMs: Date.now() - startedAt });
      return parseJson<T>(text);
    }

    if (RETRYABLE_STATUSES.includes(res.status)) {
      lastTransient = new TransientGatewayError(`midtrans ${res.status}: ${sanitize(text)}`, 'midtrans', res.status);
      logger.warn({
        ...logBase,
        attempt,
        outcome: 'retry',
        errorClass: res.status === 429 ? 'rate_limited' : 'gateway_5xx',
        status: res.status,
        elapsedMs: Date.now() - startedAt,
      });
      continue;
    }

    // Any other status (401 bad key, 406 duplicate order_id, 4xx validation) is a
    // decision by Midtrans — repeating it would just repeat the rejection.
    logger.error({ ...logBase, attempt, outcome: 'failed', errorClass: 'permanent', status: res.status, elapsedMs: Date.now() - startedAt });
    throw new PermanentGatewayError(`midtrans ${res.status}: ${sanitize(text)}`, 'midtrans', res.status);
  }

  logger.error({ ...logBase, outcome: 'failed', errorClass: 'transient_exhausted', elapsedMs: Date.now() - startedAt });
  throw lastTransient ?? new TransientGatewayError('midtrans request failed', 'midtrans');
}

/** A 2xx with an unparseable body is a broken contract, not a transient glitch. */
function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PermanentGatewayError(`invalid JSON response: ${sanitize(text)}`, 'midtrans');
  }
}
