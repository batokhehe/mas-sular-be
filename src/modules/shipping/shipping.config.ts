import { nonNegativeInt as positiveInt } from '../../common/utils/number.util';
export const SHIPPING_CONFIG = 'SHIPPING_CONFIG';

export interface PaxelProviderConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetry: number;
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

export interface ShippingConfig {
  /** Store origin postal code, used when the request origin is a placeholder. */
  originPostalCode: string;
  paxel: PaxelProviderConfig;
  jne: JneProviderConfig;
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

export function loadShippingConfig(env: NodeJS.ProcessEnv = process.env): ShippingConfig {
  return {
    originPostalCode: env.SHIPPING_ORIGIN_POSTAL_CODE ?? '40111',
    allowMockRates: env.NODE_ENV !== 'production',
    paxel: {
      enabled: bool(env.PAXEL_ENABLED),
      baseUrl: (env.PAXEL_BASE_URL ?? 'https://api.paxel.co').replace(/\/+$/, ''),
      apiKey: env.PAXEL_API_KEY,
      timeoutMs: positiveInt(env.PAXEL_TIMEOUT_MS, 8_000),
      maxRetry: positiveInt(env.PAXEL_MAX_RETRY, 2),
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
  if (config.jne.enabled) {
    if (!config.jne.apiKey) missing.push('JNE_API_KEY');
    if (!config.jne.username) missing.push('JNE_USERNAME');
    if (!config.jne.originCode) missing.push('JNE_ORIGIN_CODE');
  }
  if (missing.length) {
    throw new Error(`Shipping providers are enabled but missing credentials: ${missing.join(', ')}`);
  }
}
