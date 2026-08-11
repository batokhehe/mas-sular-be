import { positiveInt } from '../../../common/utils/number.util';

export const MIDTRANS_CONFIG = 'MIDTRANS_CONFIG';

/**
 * CORE API hosts. This provider speaks Core API (`/v2/charge`,
 * `/v2/{id}/status|cancel|expire`), which is served by `api.*` — NOT by `app.*`.
 *
 * `app.sandbox.midtrans.com` is the Snap host: it serves `/snap/v1/transactions`,
 * `snap.js`, and the customer-facing hosted payment pages. It returns a bare HTTP
 * 404 (no JSON body) for `/v2/...`, so pointing the provider there breaks every
 * charge and status call. Verified directly in Phase 5I:
 *   api.sandbox  /v2/{id}/status -> 200 {"status_code":"404","status_message":"Transaction doesn't exist."}
 *   app.sandbox  /v2/{id}/status -> 404, empty body
 *
 * A browser redirect to `app.sandbox.midtrans.com` is still correct and expected —
 * that is where Midtrans hosts the payment page. The two are different concerns.
 */
const SANDBOX_BASE_URL = 'https://api.sandbox.midtrans.com';
const PRODUCTION_BASE_URL = 'https://api.midtrans.com';

export interface MidtransConfig {
  enabled: boolean;
  serverKey?: string;
  /** Published to the browser for card tokenisation (Phase 5). Never a secret. */
  clientKey?: string;
  isProduction: boolean;
  baseUrl: string;
  timeoutMs: number;
  maxRetry: number;
}

function bool(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

/**
 * Midtrans transport configuration. `baseUrl` defaults from MIDTRANS_IS_PRODUCTION
 * so a misconfigured environment cannot silently charge real cards against the
 * sandbox (or vice versa); an explicit MIDTRANS_BASE_URL still wins for staging
 * proxies and tests.
 */
export function loadMidtransConfig(env: NodeJS.ProcessEnv = process.env): MidtransConfig {
  const isProduction = bool(env.MIDTRANS_IS_PRODUCTION);
  return {
    enabled: bool(env.MIDTRANS_ENABLED),
    serverKey: env.MIDTRANS_SERVER_KEY,
    clientKey: env.MIDTRANS_CLIENT_KEY,
    isProduction,
    baseUrl: (env.MIDTRANS_BASE_URL ?? (isProduction ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL)).replace(/\/+$/, ''),
    timeoutMs: positiveInt(env.MIDTRANS_TIMEOUT_MS, 10_000),
    maxRetry: positiveInt(env.MIDTRANS_MAX_RETRY, 2),
  };
}

/**
 * Fail fast at boot when the gateway is switched on without credentials — the
 * same belt-and-braces contract assertShippingConfigured() provides for couriers.
 * A disabled gateway needs no keys and never registers its provider.
 */
export function assertMidtransConfigured(config: MidtransConfig): void {
  if (!config.enabled) return;
  if (!config.serverKey) {
    throw new Error('MIDTRANS_ENABLED=true but MIDTRANS_SERVER_KEY is not set');
  }
  if (config.isProduction && config.baseUrl.includes('sandbox')) {
    throw new Error('MIDTRANS_IS_PRODUCTION=true but MIDTRANS_BASE_URL points at the sandbox');
  }
  // The dangerous inverse, previously unguarded (Phase 5H.2): believing you are in
  // sandbox while an explicit MIDTRANS_BASE_URL points at the LIVE gateway would
  // charge real cards. Only the sandbox host is acceptable when isProduction=false;
  // a private proxy/staging host is still allowed, a midtrans.com live host is not.
  if (!config.isProduction && /(^|\.)midtrans\.com/.test(hostOf(config.baseUrl)) && !config.baseUrl.includes('sandbox')) {
    throw new Error('MIDTRANS_IS_PRODUCTION=false but MIDTRANS_BASE_URL points at the production gateway');
  }
}

/** Host of a URL, or the raw value when it is not parseable (validation elsewhere). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
