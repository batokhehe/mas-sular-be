import { Inject, Injectable, Logger } from '@nestjs/common';
import { NOTIFICATION_SENDER_CONFIG, NotificationSenderConfig } from './notification.config';
import {
  NotificationProvider,
  NotificationSendInput,
  NotificationSendResult,
  PermanentSendError,
  TransientSendError,
} from './notification-provider';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface ResendHttpResponse {
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

export interface ResendHttpRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export type ResendHttpClient = (url: string, init: ResendHttpRequest) => Promise<ResendHttpResponse>;

/** Default client: global fetch + AbortController timeout (loosely typed to avoid DOM lib coupling). */
const defaultResendHttpClient: ResendHttpClient = async (url, init) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const controller = new g.AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    return await g.fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Resend email provider. Passes NotificationOutbox.id as the Resend Idempotency-Key
 * (provider-side dedup → exactly-once delivery effect across crash/reclaim). Maps
 * the response to PermanentSendError / TransientSendError for the sender worker.
 */
@Injectable()
export class EmailNotificationProvider implements NotificationProvider {
  readonly channel = 'EMAIL';
  private readonly logger = new Logger('EmailNotificationProvider');
  // Overridable seam for tests.
  private http: ResendHttpClient = defaultResendHttpClient;

  constructor(@Inject(NOTIFICATION_SENDER_CONFIG) private readonly config: NotificationSenderConfig) {}

  async send(input: NotificationSendInput): Promise<NotificationSendResult> {
    if (!this.config.emailApiKey || !this.config.emailFrom) {
      // Misconfiguration is transient so the breaker pauses rather than mass-FAILED.
      throw new TransientSendError('email provider not configured (RESEND_API_KEY / EMAIL_FROM)');
    }

    const body = JSON.stringify({
      from: this.config.emailFrom,
      to: input.recipient,
      subject: input.subject,
      text: input.body,
    });

    let res: ResendHttpResponse;
    try {
      res = await this.http(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.emailApiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body,
        timeoutMs: this.config.emailRequestTimeoutMs,
      });
    } catch (err) {
      // Network error / abort (timeout) → transient.
      throw new TransientSendError(`email request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.classify(res);
  }

  private async classify(res: ResendHttpResponse): Promise<NotificationSendResult> {
    const text = await res.text().catch(() => '');

    if (res.status >= 200 && res.status < 300) {
      const providerMessageId = parseId(text);
      if (!providerMessageId) this.logger.warn(`Resend ${res.status} without an id`);
      return { providerMessageId: providerMessageId ?? '' };
    }

    const reason = parseReason(text);

    if (res.status === 429) {
      throw new TransientSendError(`rate limited: ${reason}`, parseRetryAfterMs(res.headers.get('retry-after')));
    }
    if (res.status >= 500) {
      throw new TransientSendError(`provider ${res.status}: ${reason}`);
    }
    if (res.status === 401) {
      throw new TransientSendError(`auth failed: ${reason}`); // breaker pauses; ops rotates key
    }
    if (res.status === 403) {
      // Classify by reason: blocked/suppressed recipient or domain is permanent; otherwise transient.
      throw isPermanentReason(reason)
        ? new PermanentSendError(`forbidden: ${reason}`)
        : new TransientSendError(`forbidden: ${reason}`);
    }
    if (res.status === 422 || res.status === 400) {
      throw new PermanentSendError(`invalid request: ${reason}`); // invalid recipient / payload
    }
    // Any other 4xx: not fixable by retry.
    throw new PermanentSendError(`unexpected ${res.status}: ${reason}`);
  }
}

function parseId(text: string): string | undefined {
  try {
    const data = JSON.parse(text) as { id?: string };
    return typeof data.id === 'string' && data.id.length > 0 ? data.id : undefined;
  } catch {
    return undefined;
  }
}

function parseReason(text: string): string {
  try {
    const data = JSON.parse(text) as { message?: string; name?: string };
    return data.message ?? data.name ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.trunc(seconds * 1000) : undefined;
}

const PERMANENT_REASON_HINTS = ['blocked', 'suppress', 'invalid', 'not allowed', 'unverified', 'does not exist', 'denied'];

function isPermanentReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  return PERMANENT_REASON_HINTS.some((hint) => lower.includes(hint));
}
