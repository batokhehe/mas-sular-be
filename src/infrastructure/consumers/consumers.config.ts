import { positiveInt } from '../../common/utils/number.util';
export const CONSUMERS_CONFIG = 'CONSUMERS_CONFIG';

export interface ConsumersConfig {
  /** Master switch. Defaults to false; enable explicitly via CONSUMERS_ENABLED=true. */
  enabled: boolean;
  /** Broker URL. When absent the consumer stays idle (mirrors relay behavior). */
  rabbitmqUrl?: string;
  /** Max unacked messages in flight per consumer. */
  prefetch: number;
  /** Total x-death redeliveries after which a message is sent to the terminal DLQ. */
  maxAttempts: number;
  /** TTL (ms) of the retry queue — the backoff before a failed message is redelivered. */
  retryDelayMs: number;
  /** Recipient for admin-facing notifications (e.g. a new payment receipt to verify). */
  adminNotificationEmail?: string;
  /**
   * WhatsApp number for INTERNAL operational alerts (PAXELBOX-37: "a new order
   * came in, go and process it"). Same role as adminNotificationEmail on the
   * email side — an operator, never a customer. Absent ⇒ the alert is skipped,
   * exactly as a missing admin email already skips its events.
   */
  opsNotificationWhatsapp?: string;
  /** Base URL of the admin web app, used to deep-link an alert to the order. */
  adminUrl?: string;
}

export function loadConsumersConfig(env: NodeJS.ProcessEnv = process.env): ConsumersConfig {
  return {
    enabled: env.CONSUMERS_ENABLED === 'true',
    rabbitmqUrl: env.RABBITMQ_URL,
    prefetch: positiveInt(env.CONSUMER_PREFETCH, 10),
    maxAttempts: positiveInt(env.CONSUMER_MAX_ATTEMPTS, 5),
    retryDelayMs: positiveInt(env.CONSUMER_RETRY_DELAY_MS, 30_000),
    adminNotificationEmail: env.ADMIN_NOTIFICATION_EMAIL,
    opsNotificationWhatsapp: env.OPS_NOTIFICATION_WHATSAPP,
    adminUrl: env.ADMIN_URL,
  };
}
