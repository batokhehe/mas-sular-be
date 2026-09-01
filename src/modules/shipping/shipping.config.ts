import { nonNegativeInt as positiveInt } from '../../common/utils/number.util';
export const SHIPPING_CONFIG = 'SHIPPING_CONFIG';

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
      baseUrl: (env.JNE_BASE_URL ?? 'https://apiv2.jne.co.id:10102').replace(/\/+$/, ''),
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
  if (missing.length) {
    throw new Error(`Shipping providers are enabled but missing credentials: ${missing.join(', ')}`);
  }
}
