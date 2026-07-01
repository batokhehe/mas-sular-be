import { EmailNotificationProvider } from '../../src/infrastructure/notifications/email-notification.provider';
import { NotificationSenderConfig } from '../../src/infrastructure/notifications/notification.config';
import { PermanentSendError, TransientSendError } from '../../src/infrastructure/notifications/notification-provider';
import { TemplateRenderer } from '../../src/infrastructure/notifications/template-renderer';
import { TemplateRegistry } from '../../src/infrastructure/notifications/template-registry';
import { NotificationMessage } from '../../src/infrastructure/notifications/notification-message';

function config(over: Partial<NotificationSenderConfig> = {}): NotificationSenderConfig {
  return {
    enabled: true,
    batchSize: 50,
    leaseMs: 30_000,
    pollIntervalMs: 1_000,
    backoffBaseMs: 5_000,
    backoffCapMs: 3_600_000,
    maxAttempts: 8,
    healthLogIntervalMs: 60_000,
    breakerThreshold: 5,
    pauseMs: 30_000,
    emailApiKey: 'rk_test',
    emailFrom: 'orders@masular.test',
    emailRequestTimeoutMs: 10_000,
    ...over,
  };
}

function res(status: number, body = '', headers: Record<string, string> = {}) {
  return {
    status,
    text: jest.fn().mockResolvedValue(body),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

function build(cfg = config()) {
  const provider = new EmailNotificationProvider(cfg, new TemplateRenderer(), new TemplateRegistry());
  const http = jest.fn();
  (provider as any).http = http;
  return { provider, http };
}

const INPUT: NotificationMessage = {
  channel: 'EMAIL',
  template: 'order.transfer',
  recipient: { name: 'Jane', email: 'a@b.com' },
  variables: {
    template: 'order.transfer',
    customerName: 'Jane',
    orderNumber: 'BMS-1',
    totalPrice: 30000,
    uploadToken: 'tok',
    bankName: 'BCA',
    bankCode: '014',
    accountName: 'Bakso Mas Sular',
    accountNumber: '123',
  },
  metadata: { notificationId: 'n1', idempotencyKey: 'n1', externalRequestId: 'x', providerTemplateId: 'order.transfer' },
};

describe('EmailNotificationProvider (Resend)', () => {
  it('POSTs with Idempotency-Key and returns the provider id', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, JSON.stringify({ id: 'resend-123' })));

    const result = await provider.send(INPUT);

    expect(http).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer rk_test', 'Idempotency-Key': 'n1' }),
      timeoutMs: 10_000,
    }));
    expect(result.providerMessageId).toBe('resend-123');
  });

  it('treats a 2xx without an id as success (empty providerMessageId)', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(202, '{}'));
    expect(await provider.send(INPUT)).toEqual({ providerMessageId: '' });
  });

  it('invalid recipient (422) → PermanentSendError', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(422, JSON.stringify({ message: 'invalid `to` field' })));
    await expect(provider.send(INPUT)).rejects.toBeInstanceOf(PermanentSendError);
  });

  it('blocked/suppressed recipient (403 with permanent reason) → PermanentSendError', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(403, JSON.stringify({ message: 'recipient is blocked' })));
    await expect(provider.send(INPUT)).rejects.toBeInstanceOf(PermanentSendError);
  });

  it('403 with a non-permanent reason → TransientSendError', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(403, JSON.stringify({ message: 'temporary hold' })));
    await expect(provider.send(INPUT)).rejects.toBeInstanceOf(TransientSendError);
  });

  it('429 → TransientSendError carrying Retry-After (ms)', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(429, JSON.stringify({ message: 'rate limited' }), { 'retry-after': '7' }));
    const err = await provider.send(INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(TransientSendError);
    expect((err as TransientSendError).retryAfterMs).toBe(7000);
  });

  it('5xx → TransientSendError', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(503, 'unavailable'));
    await expect(provider.send(INPUT)).rejects.toBeInstanceOf(TransientSendError);
  });

  it('401 → TransientSendError (breaker pauses, not mass-FAILED)', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(401, JSON.stringify({ message: 'invalid api key' })));
    await expect(provider.send(INPUT)).rejects.toBeInstanceOf(TransientSendError);
  });

  it('network/timeout (http throws) → TransientSendError', async () => {
    const { provider, http } = build();
    http.mockRejectedValue(new Error('AbortError'));
    await expect(provider.send(INPUT)).rejects.toBeInstanceOf(TransientSendError);
  });

  it('missing credentials → TransientSendError (no HTTP call)', async () => {
    const { provider, http } = build(config({ emailApiKey: undefined }));
    await expect(provider.send(INPUT)).rejects.toBeInstanceOf(TransientSendError);
    expect(http).not.toHaveBeenCalled();
  });
});
