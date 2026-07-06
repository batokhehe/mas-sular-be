export const QONTAK_CONFIG = 'QONTAK_CONFIG';

export interface QontakConfig {
  baseUrl: string;
  apiToken?: string;
  channelIntegrationId?: string;
  orderTemplateId?: string; // transfer
  codTemplateId?: string;
  shippedTemplateId?: string; // "Pesanan Anda telah dikirim"
  deliveredTemplateId?: string; // delivery confirmation
  shipmentTemplateId?: string; // generic shipment status update
  /** Per-request timeout (ms). */
  timeoutMs: number;
  /** In-call immediate retries for transient network/5xx (complements the durable outbox retry). */
  maxRetry: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

export function loadQontakConfig(env: NodeJS.ProcessEnv = process.env): QontakConfig {
  return {
    baseUrl: (env.QONTAK_BASE_URL ?? 'https://service-chat.qontak.com').replace(/\/+$/, ''),
    apiToken: env.QONTAK_API_TOKEN,
    channelIntegrationId: env.QONTAK_CHANNEL_INTEGRATION_ID,
    orderTemplateId: env.QONTAK_ORDER_TEMPLATE_ID,
    codTemplateId: env.QONTAK_COD_TEMPLATE_ID,
    shippedTemplateId: env.QONTAK_SHIPPED_TEMPLATE_ID,
    deliveredTemplateId: env.QONTAK_DELIVERED_TEMPLATE_ID,
    shipmentTemplateId: env.QONTAK_SHIPMENT_TEMPLATE_ID,
    timeoutMs: positiveInt(env.QONTAK_TIMEOUT_MS, 10_000),
    maxRetry: positiveInt(env.QONTAK_MAX_RETRY, 1),
  };
}

/** Fail-fast: required when WhatsApp delivery is actually enabled. */
export function assertQontakConfigured(config: QontakConfig): void {
  const missing: string[] = [];
  if (!config.apiToken) missing.push('QONTAK_API_TOKEN');
  if (!config.channelIntegrationId) missing.push('QONTAK_CHANNEL_INTEGRATION_ID');
  if (!config.orderTemplateId) missing.push('QONTAK_ORDER_TEMPLATE_ID');
  if (!config.codTemplateId) missing.push('QONTAK_COD_TEMPLATE_ID');
  if (missing.length) {
    throw new Error(`WhatsApp (Qontak) notifications require: ${missing.join(', ')}`);
  }
}
