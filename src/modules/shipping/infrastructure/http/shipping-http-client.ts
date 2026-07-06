import { Logger } from '@nestjs/common';
import { PermanentError, TransientError } from '../../domain/shipping-errors';

export interface ShippingHttpResponse {
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

export interface ShippingHttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export type ShippingHttpClient = (url: string, init: ShippingHttpRequest) => Promise<ShippingHttpResponse>;

/** Real transport: fetch + AbortController timeout. Swappable in unit tests. */
export const defaultShippingHttpClient: ShippingHttpClient = async (url, init) => {
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

/** Structured log fields — deliberately excludes secrets and personal data. */
export interface ShippingLogBase {
  provider: string;
  origin: string;
  destination: string;
  service: string;
}

export interface ShippingRequestOptions {
  http: ShippingHttpClient;
  url: string;
  init: ShippingHttpRequest;
  maxRetry: number;
  logger: Logger;
  logBase: ShippingLogBase;
}

function sanitize(text: string): string {
  return text.slice(0, 300);
}

/**
 * Execute a shipping HTTP request with timeout, in-call retry, error
 * classification, and secret-free logging. Returns the raw response body text on
 * success; throws TransientError (network/timeout/5xx/429) or PermanentError (4xx).
 */
export async function executeShippingRequest(opts: ShippingRequestOptions): Promise<{ status: number; text: string }> {
  const { http, url, init, maxRetry, logger, logBase } = opts;
  const attempts = Math.max(1, maxRetry + 1);
  const startedAt = Date.now();
  let lastTransient: TransientError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res: ShippingHttpResponse;
    try {
      res = await http(url, init);
    } catch (err) {
      // AbortError (timeout) and network failures land here — retryable.
      const reason = err instanceof Error ? err.message : String(err);
      lastTransient = new TransientError(`network error: ${reason}`, logBase.provider);
      logger.warn({ ...logBase, attempt, outcome: 'retry', errorClass: 'network', elapsedMs: Date.now() - startedAt });
      continue;
    }

    const text = await res.text().catch(() => '');

    if (res.status >= 200 && res.status < 300) {
      logger.log({ ...logBase, attempt, outcome: 'ok', status: res.status, elapsedMs: Date.now() - startedAt });
      return { status: res.status, text };
    }

    if (res.status >= 500 || res.status === 429) {
      lastTransient = new TransientError(`provider ${res.status}: ${sanitize(text)}`, logBase.provider);
      logger.warn({
        ...logBase,
        attempt,
        outcome: 'retry',
        errorClass: res.status === 429 ? 'rate_limited' : 'provider_5xx',
        status: res.status,
        elapsedMs: Date.now() - startedAt,
      });
      continue;
    }

    // Any other 4xx → permanent, no retry.
    logger.error({
      ...logBase,
      attempt,
      outcome: 'failed',
      errorClass: 'permanent_4xx',
      status: res.status,
      elapsedMs: Date.now() - startedAt,
    });
    throw new PermanentError(`provider ${res.status}: ${sanitize(text)}`, logBase.provider);
  }

  logger.error({ ...logBase, outcome: 'failed', errorClass: 'transient_exhausted', elapsedMs: Date.now() - startedAt });
  throw lastTransient ?? new TransientError('shipping request failed', logBase.provider);
}
