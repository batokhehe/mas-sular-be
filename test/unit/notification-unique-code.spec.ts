import { NotificationChannel } from '@prisma/client';
import { NotificationMessageBuilder } from '../../src/infrastructure/notifications/notification-message.builder';
import { TemplateRegistry } from '../../src/infrastructure/notifications/template-registry';

const ACCOUNT = { bankName: 'BCA', bankCode: '014', accountName: 'Toko', accountNumber: '1234567890' };

function builder() {
  const accounts = { getActiveAccount: jest.fn().mockResolvedValue(ACCOUNT) };
  const registry = { resolve: jest.fn().mockReturnValue({ providerTemplateId: 'tmpl-1', body: [], button: true }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new NotificationMessageBuilder(accounts as any, registry as any);
}

function transferRow(uniqueCode: number | null) {
  return {
    id: 'ntf-1',
    channel: NotificationChannel.WHATSAPP,
    template: 'order.transfer',
    recipient: '6281234567890',
    attempts: 0,
    payload: {
      orderNumber: 'BMS-1',
      // totalPrice is the final transfer amount (unique code already folded in).
      totalPrice: 135123,
      customerName: 'Jane',
      customerPhone: '6281234567890',
      uploadToken: 'raw-token',
      // Even if a code is present on the payload, the notification must not surface it.
      uniqueCode,
    },
  } as never;
}

describe('NotificationMessageBuilder — order.transfer omits the unique code', () => {
  it('shows only the total (no separate unique-code field) even when a code is present', async () => {
    const msg = await builder().build(transferRow(123));
    expect(msg.template).toBe('order.transfer');
    expect(msg.variables).toMatchObject({ template: 'order.transfer', totalPrice: 135123 });
    expect(msg.variables as Record<string, unknown>).not.toHaveProperty('uniqueCode');
  });

  it('works for QRIS/legacy (no code) identically', async () => {
    const msg = await builder().build(transferRow(null));
    expect(msg.variables as Record<string, unknown>).not.toHaveProperty('uniqueCode');
  });
});

describe('TemplateRegistry — WhatsApp order.transfer parameter count', () => {
  it('declares exactly 6 body params and no unique_code (matches the builder)', () => {
    // Provider template id must be present for resolve() to succeed.
    const prev = process.env.QONTAK_ORDER_TEMPLATE_ID;
    process.env.QONTAK_ORDER_TEMPLATE_ID = 'wa-order-tmpl';
    try {
      const registry = new TemplateRegistry();
      const descriptor = registry.resolve(NotificationChannel.WHATSAPP, 'order.transfer');
      expect(descriptor.body).toHaveLength(6);
      expect(descriptor.body?.some((p) => p.source === 'uniqueCode')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.QONTAK_ORDER_TEMPLATE_ID;
      else process.env.QONTAK_ORDER_TEMPLATE_ID = prev;
    }
  });
});
