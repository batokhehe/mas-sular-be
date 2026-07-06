import { loadNotificationSenderConfig } from '../../src/infrastructure/notifications/notification.config';
import { TemplateRenderer } from '../../src/infrastructure/notifications/template-renderer';
import { PermanentSendError } from '../../src/infrastructure/notifications/notification-provider';

describe('loadNotificationSenderConfig', () => {
  it('defaults enabled to false with sane defaults', () => {
    const cfg = loadNotificationSenderConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxAttempts).toBe(8);
    expect(cfg.breakerThreshold).toBe(5);
    expect(cfg.emailRequestTimeoutMs).toBe(10_000);
  });

  it('parses email + sender overrides when enabled', () => {
    const cfg = loadNotificationSenderConfig({
      NOTIFICATION_SENDER_ENABLED: 'true',
      NOTIFICATION_SENDER_MAX_ATTEMPTS: '3',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'orders@masular.test',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.emailApiKey).toBe('rk_test');
    expect(cfg.emailFrom).toBe('orders@masular.test');
  });

  it('fails fast when enabled without RESEND_API_KEY / EMAIL_FROM', () => {
    expect(() => loadNotificationSenderConfig({ NOTIFICATION_SENDER_ENABLED: 'true' })).toThrow(/RESEND_API_KEY/);
  });

  it('fails fast when the request timeout is >= the lease', () => {
    expect(() =>
      loadNotificationSenderConfig({
        NOTIFICATION_SENDER_ENABLED: 'true',
        RESEND_API_KEY: 'rk',
        EMAIL_FROM: 'f@x.test',
        NOTIFICATION_SENDER_LEASE_MS: '5000',
        EMAIL_REQUEST_TIMEOUT_MS: '5000',
      }),
    ).toThrow(/EMAIL_REQUEST_TIMEOUT_MS/);
  });
});

describe('TemplateRenderer', () => {
  const renderer = new TemplateRenderer();

  it('renders order.received', () => {
    const out = renderer.render('order.received', { orderNumber: 'BMS-1', customerName: 'Jane', totalPrice: 30000 });
    expect(out.subject).toContain('BMS-1');
    expect(out.body).toContain('Jane');
  });

  it('renders payment.approved', () => {
    const out = renderer.render('payment.approved', { orderNumber: 'BMS-1', customerName: 'Jane' });
    expect(out.subject).toContain('BMS-1');
    expect(out.body).toContain('Jane');
    expect(out.body).toContain('processed');
  });

  it('renders payment.rejected', () => {
    const out = renderer.render('payment.rejected', { orderNumber: 'BMS-1', customerName: 'Jane' });
    expect(out.subject).toContain('BMS-1');
    expect(out.body).toContain('could not verify');
  });

  it('renders payment.expired', () => {
    const out = renderer.render('payment.expired', { orderNumber: 'BMS-1', customerName: 'Jane' });
    expect(out.subject).toContain('BMS-1');
    expect(out.body).toContain('expired');
  });

  it('renders payment.receipt_uploaded (admin-facing)', () => {
    const out = renderer.render('payment.receipt_uploaded', { orderNumber: 'BMS-1', customerName: 'Jane' });
    expect(out.subject).toContain('BMS-1');
    expect(out.body).toContain('Jane');
    expect(out.body).toContain('verify');
  });

  it('renders payment.reminder with the upload link and stage-based tone', () => {
    const base = { orderNumber: 'BMS-1', customerName: 'Jane', paymentMethod: 'BANK_TRANSFER', amount: 50000, uploadUrl: 'https://app/payments/upload/raw' };
    const first = renderer.render('payment.reminder', { ...base, stage: 'first' });
    expect(first.subject).toContain('BMS-1');
    expect(first.body).toContain('https://app/payments/upload/raw');
    const second = renderer.render('payment.reminder', { ...base, stage: 'second' });
    expect(second.body).toContain('final reminder');
  });

  it('renders order.transfer with only the total transfer amount — no unique-code section', () => {
    const out = renderer.render('order.transfer', {
      orderNumber: 'BMS-1', customerName: 'Jane', totalPrice: 135123, uniqueCode: 123,
      bankName: 'BCA', accountName: 'Toko', accountNumber: '123',
    });
    // Total payment (final transfer amount) is shown...
    expect(out.body).toContain('135123');
    // ...but the unique code is never called out separately (already in the total).
    expect(out.body).not.toContain('Kode unik');
    expect(out.body).not.toMatch(/TEPAT/i);
  });

  it('throws PermanentSendError for an unknown template', () => {
    expect(() => renderer.render('nope', {})).toThrow(PermanentSendError);
  });
});
