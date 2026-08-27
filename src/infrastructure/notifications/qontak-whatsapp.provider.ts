import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { maskPhone } from '../../common/utils/phone.util';
import { NotificationMessage } from './notification-message';
import {
  NotificationProvider,
  NotificationSendResult,
  PermanentSendError,
  TransientSendError,
} from './notification-provider';
import { QONTAK_CONFIG, QontakConfig } from './qontak.config';
import { TemplateRegistry } from './template-registry';

const BROADCAST_PATH = '/api/open/v1/broadcasts/whatsapp/direct';

export interface QontakHttpResponse {
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}
export interface QontakHttpRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}
export type QontakHttpClient = (url: string, init: QontakHttpRequest) => Promise<QontakHttpResponse>;

const defaultHttpClient: QontakHttpClient = async (url, init) => {
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

function formatCurrency(value: number): string {
  return `Rp ${Math.round(value).toLocaleString('id-ID')}`;
}

/**
 * Transport-only WhatsApp provider for Mekari Qontak. Performs NO database
 * queries, NO template selection (receives the resolved descriptor), and NO
 * business logic — it maps a NotificationMessage to the Qontak body, sends it,
 * classifies the response, and logs (without secrets).
 */
@Injectable()
export class QontakWhatsAppProvider implements NotificationProvider {
  readonly channel = NotificationChannel.WHATSAPP;
  private readonly logger = new Logger('QontakWhatsAppProvider');
  private http: QontakHttpClient = defaultHttpClient;

  constructor(
    @Inject(QONTAK_CONFIG) private readonly config: QontakConfig,
    private readonly registry: TemplateRegistry,
  ) {}

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    if (!this.config.apiToken || !this.config.channelIntegrationId) {
      throw new TransientSendError('Qontak not configured (QONTAK_API_TOKEN / QONTAK_CHANNEL_INTEGRATION_ID)');
    }
    const phone = message.recipient.phone;
    if (!phone) {
      throw new PermanentSendError('recipient phone is missing'); // builder normalizes; guard only
    }

    const descriptor = this.registry.resolve(message.channel, message.template);
    const vars = message.variables as unknown as Record<string, unknown>;

    const body = (descriptor.body ?? []).map((p) => {
      const raw = vars[p.source];
      const text = p.format === 'currency' ? formatCurrency(Number(raw)) : String(raw ?? '');
      return { key: p.key, value_text: text, value: p.valueName };
    });

    // The button's URL slot is fed by whichever variable the descriptor names.
    // Defaults to uploadToken so templates registered before buttonSource
    // existed behave exactly as they did.
    const buttonValue = vars[descriptor.buttonSource ?? 'uploadToken'];
    const buttons =
      descriptor.button && typeof buttonValue === 'string' && buttonValue.length > 0
        ? [{ index: '0', type: 'url', value: buttonValue }]
        : undefined;

    const payload = {
      to_name: message.recipient.name,
      to_number: phone,
      message_template_id: message.metadata.providerTemplateId,
      channel_integration_id: this.config.channelIntegrationId,
      language: { code: 'id' },
      parameters: { body, ...(buttons ? { buttons } : {}) },
    };

    const url = `${this.config.baseUrl}${BROADCAST_PATH}`;
    const startedAt = Date.now();
    const attempts = Math.max(1, this.config.maxRetry + 1);
    let lastTransient: TransientSendError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res: QontakHttpResponse;
      try {
        res = await this.http(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiToken}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': message.metadata.idempotencyKey,
            'X-External-Id': message.metadata.externalRequestId,
          },
          body: JSON.stringify(payload),
          timeoutMs: this.config.timeoutMs,
        });
      } catch (err) {
        lastTransient = new TransientSendError(`network error: ${err instanceof Error ? err.message : String(err)}`);
        continue; // in-call retry for network/timeout
      }
      const outcome = await this.classify(res, message, phone, Date.now() - startedAt);
      if (outcome.kind === 'ok') return { providerMessageId: outcome.providerMessageId };
      if (outcome.kind === 'permanent') throw outcome.error;
      lastTransient = outcome.error; // 5xx/429 → in-call retry then surface to durable retry
    }
    throw lastTransient ?? new TransientSendError('qontak send failed');
  }

  private async classify(
    res: QontakHttpResponse,
    message: NotificationMessage,
    phone: string,
    elapsedMs: number,
  ): Promise<{ kind: 'ok'; providerMessageId: string } | { kind: 'permanent' | 'transient'; error: PermanentSendError | TransientSendError }> {
    const text = await res.text().catch(() => '');
    const base = {
      notificationId: message.metadata.notificationId,
      channel: message.channel,
      provider: 'qontak',
      template: message.template,
      providerTemplateId: message.metadata.providerTemplateId,
      recipient: maskPhone(phone),
      orderNumber: (message.variables as { orderNumber?: string }).orderNumber,
      externalRequestId: message.metadata.externalRequestId,
      elapsedMs,
      responseStatus: res.status,
    };

    if (res.status >= 200 && res.status < 300) {
      const providerMessageId = parseId(text);
      this.logger.log({ ...base, outcome: 'sent', providerMessageId });
      return { kind: 'ok', providerMessageId: providerMessageId ?? '' };
    }

    const reason = sanitize(text);
    if (res.status === 429) {
      this.logger.warn({ ...base, outcome: 'retry', errorClass: 'rate_limited', reason });
      return { kind: 'transient', error: new TransientSendError(`rate limited: ${reason}`, parseRetryAfterMs(res.headers.get('retry-after'))) };
    }
    if (res.status >= 500) {
      this.logger.warn({ ...base, outcome: 'retry', errorClass: 'provider_5xx', reason });
      return { kind: 'transient', error: new TransientSendError(`provider ${res.status}: ${reason}`) };
    }
    if (res.status === 401) {
      this.logger.warn({ ...base, outcome: 'retry', errorClass: 'auth', reason });
      return { kind: 'transient', error: new TransientSendError(`auth failed: ${reason}`) };
    }
    // All other 4xx (400/403/404/422/…) → permanent.
    this.logger.error({ ...base, outcome: 'failed', errorClass: 'permanent_4xx', reason });
    return { kind: 'permanent', error: new PermanentSendError(`qontak ${res.status}: ${reason}`) };
  }
}

function parseId(text: string): string | undefined {
  try {
    const data = JSON.parse(text) as { data?: { id?: string }; id?: string };
    return data.data?.id ?? data.id;
  } catch {
    return undefined;
  }
}
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.trunc(seconds * 1000) : undefined;
}
function sanitize(text: string): string {
  return text.slice(0, 300);
}
