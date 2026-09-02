import { nonNegativeInt as positiveInt } from '../../common/utils/number.util';
export const SHIPPING_CONFIG = 'SHIPPING_CONFIG';

/**
 * The JNE integration specification supplied with this project (PAXELBOX-61A/61B)
 * names this host:port as the SANDBOX for every JNE API - getorigin,
 * getdestination, pricedev, pickupcashless and tracing. It is recorded here as a
 * REJECT list for production, never as something to fall back to.
 *
 * There is deliberately NO production constant beside it. PAXELBOX-61J established
 * that JNE has supplied no production endpoint, and inventing one is precisely the
 * mistake this guard exists to prevent.
 */
export const JNE_SANDBOX_HOSTS = ['apiv2.jne.co.id:10202'];

/** Which JNE tenant a configuration addresses. Any other value is an error. */
export type JneEnvironment = 'sandbox' | 'production';

export interface PaxelProviderConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  /** Signs create/cancel requests (X-Paxel-Signature). Never logged, never returned. */
  apiSecret?: string;
  /**
   * Merchant pickup contact, sent as `origin.phone` on shipment creation.
   * Configured rather than stored on Outlet for now: Outlet has no contact
   * column, and inventing one per outlet is a schema decision this phase does
   * not take. Paxel requires 9-13 digits.
   */
  originPhone?: string;
  /**
   * Pickup instruction for the Paxel driver, sent as `origin.note`. Required by
   * Paxel and deliberately WITHOUT a default - it is a real instruction about
   * reaching the pickup point ("side entrance", "ask for the shift lead"), and
   * a placeholder would be shipped to a courier as if it were true.
   */
  originNote?: string;
  /**
   * Paxel's required `need_insurance`. Off unless deliberately switched on:
   * insurance costs money per shipment, so it is never enabled by accident or
   * by an absent variable.
   */
  needInsurance: boolean;
  timeoutMs: number;
  maxRetry: number;
  /**
   * Parcel envelope sent as Paxel's required `dimension`, format LxWxH in cm.
   *
   * Configured, not derived: the catalogue carries no physical product
   * attributes (no weight, length, width or height on Product), so there is
   * nothing to compute a real parcel size from today. Paxel resolves the price
   * bucket server-side from whatever dimension we send and returns the answer
   * in `fixed_price`, so this value directly determines what the customer is
   * quoted - keep it in config where it is visible, never inline in code.
   */
  defaultDimension: string;
}

export interface JneProviderConfig {
  enabled: boolean;
  /**
   * Which JNE tenant `baseUrl` and the credentials address (PAXELBOX-61K).
   *
   * ABSENT MEANS SANDBOX. A courier must never be promoted to live traffic by an
   * unset variable, so there is no path by which omitting this yields production.
   * `loadShippingConfig` always sets it explicitly; the field stays optional so a
   * hand-built config (every existing test) keeps its safe meaning.
   */
  environment?: JneEnvironment;
  baseUrl: string;
  apiKey?: string;
  username?: string;
  /** JNE origin city/area code (their API keys off internal codes, not postal). */
  originCode?: string;
  timeoutMs: number;
  maxRetry: number;
}

/**
 * RajaOngkir is the RATE SOURCE for JNE (PAXELBOX-45) — not a courier of its
 * own. It never appears as a provider name, never books a shipment and never
 * tracks one; JNE remains the business identity end to end.
 *
 * Kept separate from JneProviderConfig because the two are independent: JNE's
 * own credentials still serve tracking, while these serve quotation only.
 */
export interface RajaOngkirConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetry: number;
}

export interface ShippingConfig {
  /** Store origin postal code, used when the request origin is a placeholder. */
  originPostalCode: string;
  paxel: PaxelProviderConfig;
  jne: JneProviderConfig;
  /** RajaOngkir — the RATE source behind the `jne` quotation provider. */
  rajaongkir: RajaOngkirConfig;
  /**
   * When a provider is disabled (no credentials), fall back to a clearly-labeled
   * mock quote instead of contributing none, so checkout stays testable locally.
   * Never true in production — a disabled provider must never fabricate a price
   * for a real customer.
   */
  allowMockRates: boolean;
}

function bool(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

/**
 * Paxel documents origin/destination phone as min:9,max:13. Digits only - the
 * value goes straight into the shipment request, so a formatted string like
 * "+62 812-1212" would be rejected at booking rather than at boot.
 */
export function isPaxelPhone(value: string | undefined): boolean {
  return !!value && /^\d{9,13}$/.test(value.trim());
}

/**
 * Paxel documents `dimension` as max:11 chars, between 1x1x1 and 50x50x50.
 * Validated at boot so a typo surfaces as a config error rather than as a 400
 * on a customer's checkout.
 */
export function isPaxelDimension(value: string | undefined): boolean {
  if (!value) return false;
  const match = /^(\d{1,2})x(\d{1,2})x(\d{1,2})$/.exec(value.trim());
  if (!match) return false;
  return [match[1], match[2], match[3]].every((side) => {
    const n = Number(side);
    return n >= 1 && n <= 50;
  });
}

export function loadShippingConfig(env: NodeJS.ProcessEnv = process.env): ShippingConfig {
  // Cast, not parse: an unrecognised value must survive to assertJneEnvironment()
  // and be REJECTED there. Coercing it to a default here would silently downgrade
  // a misspelt "production" into sandbox, which is the failure mode this guard is
  // for. env.validation rejects it at boot; this is the second line.
  const jneEnvironment = env.JNE_ENVIRONMENT as JneEnvironment | undefined;
  return {
    originPostalCode: env.SHIPPING_ORIGIN_POSTAL_CODE ?? '40111',
    allowMockRates: env.NODE_ENV !== 'production',
    paxel: {
      enabled: bool(env.PAXEL_ENABLED),
      baseUrl: (env.PAXEL_BASE_URL ?? 'https://api.paxel.co').replace(/\/+$/, ''),
      apiKey: env.PAXEL_API_KEY,
      apiSecret: env.PAXEL_API_SECRET,
      originPhone: env.PAXEL_ORIGIN_PHONE,
      originNote: env.PAXEL_ORIGIN_NOTE,
      needInsurance: bool(env.PAXEL_NEED_INSURANCE),
      timeoutMs: positiveInt(env.PAXEL_TIMEOUT_MS, 8_000),
      maxRetry: positiveInt(env.PAXEL_MAX_RETRY, 2),
      defaultDimension: env.PAXEL_DEFAULT_DIMENSION ?? '30x35x20',
    },
    jne: {
      enabled: bool(env.JNE_ENABLED),
      // Absent means sandbox - never production.
      environment: jneEnvironment ?? 'sandbox',
      // Production has NO default endpoint, on purpose: JNE has supplied none
      // (PAXELBOX-61J), so an unset JNE_BASE_URL must fail the guard rather than
      // resolve to a URL of unknown provenance. The sandbox default is unchanged.
      baseUrl: (jneEnvironment === 'production'
        ? (env.JNE_BASE_URL ?? '')
        : (env.JNE_BASE_URL ?? 'https://apiv2.jne.co.id:10102')
      ).replace(/\/+$/, ''),
      apiKey: env.JNE_API_KEY,
      username: env.JNE_USERNAME,
      originCode: env.JNE_ORIGIN_CODE,
      timeoutMs: positiveInt(env.JNE_TIMEOUT_MS, 8_000),
      maxRetry: positiveInt(env.JNE_MAX_RETRY, 2),
    },
    rajaongkir: {
      // Enabled only with an explicit key: without one the provider must not
      // pretend it can price anything.
      enabled: bool(env.RAJAONGKIR_ENABLED) && Boolean(env.RAJAONGKIR_API_KEY),
      baseUrl: (env.RAJAONGKIR_BASE_URL ?? 'https://rajaongkir.komerce.id/api/v1').replace(/\/+$/, ''),
      apiKey: env.RAJAONGKIR_API_KEY,
      timeoutMs: positiveInt(env.RAJAONGKIR_TIMEOUT_MS, 8_000),
      // 1 = no in-call retry beyond the first attempt. RajaOngkir's 429 means a
      // DAILY quota is spent (PAXELBOX-41C); the shared client already refuses
      // to retry 429 (PAXELBOX-45A), and burning retries on 5xx spends the same
      // quota, so this stays deliberately low.
      maxRetry: positiveInt(env.RAJAONGKIR_MAX_RETRY, 1),
    },
  };
}

/** Host of a URL, or the raw value when it is not parseable (validation elsewhere). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** True when `url` addresses the JNE endpoint the supplied specification calls sandbox. */
export function isJneSandboxUrl(url: string): boolean {
  return JNE_SANDBOX_HOSTS.includes(hostOf(url).toLowerCase());
}

/**
 * JNE environment guard (PAXELBOX-61K).
 *
 * `trackShipmentRaw` and `cancelShipment` both spend `jne.baseUrl`, and JNE
 * consignments are booked by hand - so an enabled courier pointed at the sandbox
 * answers questions about REAL cnotes with sandbox data and writes the answer to
 * a customer's shipment status. Midtrans has had a guard against this class of
 * mistake since Phase 5H.2; the courier never got one.
 *
 * It is NOT a copy of that guard. Midtrans knows both of its hosts, so it polices
 * the mismatch in both directions. Only the SANDBOX host is known here
 * (PAXELBOX-61J: JNE has supplied no production endpoint), so the rule is
 * one-directional of necessity - production may not use the sandbox, and
 * production must name an endpoint of its own. The inverse, a sandbox environment
 * quietly pointed at production, is undetectable until JNE names that host, and is
 * left as a stated gap rather than guessed at with a hostname heuristic.
 *
 * Nothing here infers the environment: not from the URL, not from NODE_ENV.
 */
export function assertJneEnvironment(config: JneProviderConfig): void {
  // A disabled courier issues no requests, so it needs no endpoint and no tenant.
  if (!config.enabled) return;

  const environment = config.environment ?? 'sandbox';
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(`JNE_ENVIRONMENT must be "sandbox" or "production" (got "${environment}")`);
  }
  if (environment === 'sandbox') return;

  if (!config.baseUrl) {
    throw new Error(
      'JNE production configuration is incomplete: JNE_BASE_URL must name the official JNE ' +
        'production endpoint when JNE_ENVIRONMENT=production. There is no default, because JNE ' +
        'has not supplied a production endpoint.',
    );
  }
  if (isJneSandboxUrl(config.baseUrl)) {
    throw new Error('JNE is enabled in production but JNE_BASE_URL points to the known sandbox endpoint.');
  }
}

/**
 * Fail-fast: when a provider is enabled its credentials must be present. Mirrors
 * the env.validation cross-field check so misconfiguration is caught at boot even
 * if the config is loaded outside the ConfigModule pipeline.
 */
export function assertShippingConfigured(config: ShippingConfig): void {
  const missing: string[] = [];
  if (config.paxel.enabled && !config.paxel.apiKey) missing.push('PAXEL_API_KEY');
  if (config.paxel.enabled && !config.paxel.apiSecret) missing.push('PAXEL_API_SECRET');
  if (config.paxel.enabled && !isPaxelPhone(config.paxel.originPhone)) {
    missing.push('PAXEL_ORIGIN_PHONE (expected 9-13 digits)');
  }
  if (config.paxel.enabled && !config.paxel.originNote?.trim()) {
    missing.push('PAXEL_ORIGIN_NOTE (pickup instruction for the courier)');
  }
  if (config.paxel.enabled && !isPaxelDimension(config.paxel.defaultDimension)) {
    missing.push('PAXEL_DEFAULT_DIMENSION (expected LxWxH in cm, each side 1-50)');
  }
  if (config.jne.enabled) {
    if (!config.jne.apiKey) missing.push('JNE_API_KEY');
    if (!config.jne.username) missing.push('JNE_USERNAME');
    if (!config.jne.originCode) missing.push('JNE_ORIGIN_CODE');
  }
  // Environment safety is a separate failure from a missing credential, and says
  // so in its own words rather than joining the "missing credentials" list.
  assertJneEnvironment(config.jne);
  if (missing.length) {
    throw new Error(`Shipping providers are enabled but missing credentials: ${missing.join(', ')}`);
  }
}
