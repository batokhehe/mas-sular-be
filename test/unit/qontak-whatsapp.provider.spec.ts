import { QontakWhatsAppProvider } from '../../src/infrastructure/notifications/qontak-whatsapp.provider';
import { TemplateRegistry } from '../../src/infrastructure/notifications/template-registry';
import { QontakConfig } from '../../src/infrastructure/notifications/qontak.config';
import { NotificationMessage } from '../../src/infrastructure/notifications/notification-message';
import { PermanentSendError, TransientSendError } from '../../src/infrastructure/notifications/notification-provider';

function cfg(over: Partial<QontakConfig> = {}): QontakConfig {
  return {
    baseUrl: 'https://service-chat.qontak.com',
    apiToken: 'tok',
    channelIntegrationId: 'ci',
    orderTemplateId: 'tpl-order',
    codTemplateId: 'tpl-cod',
    timeoutMs: 10_000,
    maxRetry: 1,
    ...over,
  };
}

function transferMessage(): NotificationMessage {
  return {
    channel: 'WHATSAPP',
    template: 'order.transfer',
    recipient: { name: 'Jane', phone: '628123456789' },
    variables: {
      template: 'order.transfer',
      customerName: 'Jane',
      orderNumber: 'BMS-1',
      totalPrice: 30123,
      uploadToken: 'RAWTOKEN',
      bankName: 'BCA',
      bankCode: '014',
      accountName: 'Bakso Mas Sular',
      accountNumber: '1234567890',
    },
    metadata: { notificationId: 'n1', idempotencyKey: 'n1', externalRequestId: 'ord:BMS-1:n1', providerTemplateId: 'tpl-order' },
  };
}

function okRes(id = 'q-1') {
  return { status: 200, text: async () => JSON.stringify({ data: { id } }), headers: { get: () => null } };
}

describe('QontakWhatsAppProvider', () => {
  beforeAll(() => {
    process.env.QONTAK_ORDER_TEMPLATE_ID = 'tpl-order';
    process.env.QONTAK_COD_TEMPLATE_ID = 'tpl-cod';
  });

  it('builds the exact Qontak body and returns the provider message id', async () => {
    const provider = new QontakWhatsAppProvider(cfg(), new TemplateRegistry());
    const http = jest.fn().mockResolvedValue(okRes('q-1'));
    (provider as unknown as { http: unknown }).http = http;

    const res = await provider.send(transferMessage());
    expect(res.providerMessageId).toBe('q-1');

    const call = http.mock.calls[0][1] as { body: string; headers: Record<string, string> };
    expect(call.headers.Authorization).toBe('Bearer tok');
    const body = JSON.parse(call.body);

    expect(body).toMatchObject({
      to_name: 'Jane',
      to_number: '628123456789',
      message_template_id: 'tpl-order',
      channel_integration_id: 'ci',
      language: { code: 'id' },
    });
    // Body params: exact keys + value-names, order preserved.
    // The unique code is NOT a separate WhatsApp parameter — the total already includes it.
    expect(body.parameters.body.map((p: { key: string; value: string }) => ({ key: p.key, value: p.value }))).toEqual([
      { key: '1', value: 'customer_name' },
      { key: '2', value: 'order_no' },
      { key: '3', value: 'price' },
      { key: '4', value: 'bank_name' },
      { key: '5', value: 'account_name' },
      { key: '6', value: 'account_number' },
    ]);
    expect(body.parameters.body).toHaveLength(6);
    expect(body.parameters.body[0].value_text).toBe('Jane');
    // Price param carries the final transfer amount (unique code already folded in).
    expect(body.parameters.body[2].value_text).toMatch(/^Rp 30[.,]123$/);
    expect(body.parameters.body[3].value_text).toBe('BCA');
    // Button carries ONLY the raw token — never the full URL / hash.
    expect(body.parameters.buttons).toEqual([{ index: '0', type: 'url', value: 'RAWTOKEN' }]);
    expect(call.body).not.toContain('http');
  });

  it('COD template omits the button', async () => {
    const provider = new QontakWhatsAppProvider(cfg(), new TemplateRegistry());
    (provider as unknown as { http: unknown }).http = jest.fn().mockResolvedValue(okRes());
    const cod: NotificationMessage = {
      channel: 'WHATSAPP',
      template: 'order.cod',
      recipient: { name: 'Jane', phone: '628123456789' },
      variables: { template: 'order.cod', customerName: 'Jane', orderNumber: 'BMS-2', totalPrice: 40000, deliveryInfo: 'COD' },
      metadata: { notificationId: 'n2', idempotencyKey: 'n2', externalRequestId: 'x', providerTemplateId: 'tpl-cod' },
    };
    await provider.send(cod);
    const body = JSON.parse((provider as unknown as { http: jest.Mock }).http.mock.calls[0][1].body);
    expect(body.message_template_id).toBe('tpl-cod');
    expect(body.parameters.buttons).toBeUndefined();
  });

  it('4xx → PermanentSendError, 5xx → TransientSendError', async () => {
    const p4 = new QontakWhatsAppProvider(cfg(), new TemplateRegistry());
    (p4 as unknown as { http: unknown }).http = jest.fn().mockResolvedValue({ status: 400, text: async () => 'bad', headers: { get: () => null } });
    await expect(p4.send(transferMessage())).rejects.toBeInstanceOf(PermanentSendError);

    const p5 = new QontakWhatsAppProvider(cfg({ maxRetry: 0 }), new TemplateRegistry());
    (p5 as unknown as { http: unknown }).http = jest.fn().mockResolvedValue({ status: 503, text: async () => 'down', headers: { get: () => null } });
    await expect(p5.send(transferMessage())).rejects.toBeInstanceOf(TransientSendError);
  });
});
