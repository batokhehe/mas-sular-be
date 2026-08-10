import { GatewayTransactionStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import {
  extractChannelArtifacts,
  MIDTRANS_CHANNEL_MAP,
  midtransSpecFor,
  midtransSupportedChannels,
} from '../../src/modules/payments/gateway/domain/midtrans-channel.map';
import { PAYMENT_CHANNELS } from '../../src/modules/payments/gateway/domain/payment-channel';
import {
  PermanentGatewayError,
  TransientGatewayError,
} from '../../src/modules/payments/gateway/domain/payment-gateway-errors';
import { RETRYABLE_STATUSES } from '../../src/modules/payments/gateway/infrastructure/http/midtrans-http.client';
import {
  mapMidtransStatus,
  MidtransPaymentProvider,
} from '../../src/modules/payments/gateway/infrastructure/providers/midtrans-payment.provider';
import { assertMidtransConfigured, loadMidtransConfig, MidtransConfig } from '../../src/modules/payments/gateway/midtrans.config';
import { PaymentChannelRegistry } from '../../src/modules/payments/gateway/payment-channel.registry';
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory';

const CONFIG: MidtransConfig = {
  enabled: true,
  serverKey: 'SB-Mid-server-TEST',
  clientKey: 'SB-Mid-client-TEST',
  isProduction: false,
  baseUrl: 'https://api.sandbox.midtrans.com',
  timeoutMs: 5000,
  maxRetry: 2,
};

const REQUEST = {
  paymentId: 'pay-1',
  orderId: 'o-1',
  orderNumber: 'BMS-20260711-001',
  amount: 130000,
  customer: { name: 'Budi', email: 'b@t.com', phone: '628123' },
  attemptId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
};

/** Scripted transport: no real HTTP ever leaves the test. */
function httpStub(script: Array<{ status: number; body: unknown } | Error>) {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  let i = 0;
  const http = jest.fn(async (url: string, init: Record<string, unknown>) => {
    calls.push({ url, init });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    return { status: step.status, text: async () => JSON.stringify(step.body) };
  });
  return { http, calls };
}

function provider(script: Array<{ status: number; body: unknown } | Error>, config: MidtransConfig = CONFIG) {
  const p = new MidtransPaymentProvider(config);
  const { http, calls } = httpStub(script);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p.setHttpClient(http as any);
  return { p, http, calls };
}

const pending = (extra: Record<string, unknown> = {}) => ({
  status_code: '201',
  transaction_id: 'trx-9',
  order_id: 'BMS-20260711-001-a1b2c3d4',
  transaction_status: 'pending',
  payment_type: 'qris',
  gross_amount: '130000.00',
  expiry_time: '2026-07-12 10:00:00',
  ...extra,
});

describe('midtrans config', () => {
  it('defaults the base URL from IS_PRODUCTION and never mixes them up', () => {
    expect(loadMidtransConfig({ MIDTRANS_IS_PRODUCTION: 'false' } as never).baseUrl).toContain('sandbox');
    expect(loadMidtransConfig({ MIDTRANS_IS_PRODUCTION: 'true' } as never).baseUrl).toBe('https://api.midtrans.com');
  });

  it('is disabled by default and needs no credentials', () => {
    const config = loadMidtransConfig({} as never);
    expect(config.enabled).toBe(false);
    expect(() => assertMidtransConfigured(config)).not.toThrow();
  });

  it('fails fast when enabled without a server key, or production pointed at sandbox', () => {
    expect(() => assertMidtransConfigured({ ...CONFIG, serverKey: undefined })).toThrow(/MIDTRANS_SERVER_KEY/);
    expect(() => assertMidtransConfigured({ ...CONFIG, isProduction: true })).toThrow(/sandbox/);
  });
});

describe('channel mapping (single source of truth)', () => {
  it('covers every gateway channel in the catalog — and never MANUAL_TRANSFER', () => {
    const gatewayCodes = PAYMENT_CHANNELS.filter((c) => c.provider === 'midtrans').map((c) => c.code).sort();
    expect(midtransSupportedChannels().sort()).toEqual(gatewayCodes);
    expect(MIDTRANS_CHANNEL_MAP.MANUAL_TRANSFER).toBeUndefined();
  });

  it.each([
    ['QRIS', 'qris', undefined],
    ['GOPAY', 'gopay', undefined],
    ['SHOPEEPAY', 'shopeepay', undefined],
    ['BCA_VA', 'bank_transfer', 'bca'],
    ['BNI_VA', 'bank_transfer', 'bni'],
    ['BRI_VA', 'bank_transfer', 'bri'],
    ['PERMATA_VA', 'bank_transfer', 'permata'],
    ['MANDIRI_BILL', 'echannel', undefined],
    ['CREDIT_CARD', 'credit_card', undefined],
  ])('%s → payment_type %s (bank %s)', (channel, paymentType, bank) => {
    const spec = midtransSpecFor(channel as never)!;
    expect(spec.paymentType).toBe(paymentType);
    expect(spec.bank).toBe(bank);
  });

  it('extracts the right artifact per channel shape', () => {
    expect(extractChannelArtifacts('BCA_VA', { va_numbers: [{ bank: 'bca', va_number: '8808111' }] }).vaNumber).toBe('8808111');
    expect(extractChannelArtifacts('PERMATA_VA', { permata_va_number: '77712345' }).vaNumber).toBe('77712345');
    expect(extractChannelArtifacts('MANDIRI_BILL', { bill_key: '9911', biller_code: '70012' }).vaNumber).toBe('70012:9911');
    expect(extractChannelArtifacts('QRIS', { qr_string: 'QR-PAYLOAD' }).qrString).toBe('QR-PAYLOAD');
    expect(extractChannelArtifacts('GOPAY', { actions: [{ name: 'deeplink-redirect', url: 'gojek://x' }] }).deeplinkUrl).toBe('gojek://x');
    expect(extractChannelArtifacts('CREDIT_CARD', { redirect_url: 'https://3ds' }).redirectUrl).toBe('https://3ds');
  });
});

describe('midtrans status mapping', () => {
  it.each([
    ['pending', undefined, GatewayTransactionStatus.PENDING],
    ['authorize', undefined, GatewayTransactionStatus.AUTHORIZED],
    ['capture', 'accept', GatewayTransactionStatus.CAPTURED],
    ['settlement', undefined, GatewayTransactionStatus.SETTLEMENT],
    ['deny', undefined, GatewayTransactionStatus.FAILED],
    ['failure', undefined, GatewayTransactionStatus.FAILED],
    ['cancel', undefined, GatewayTransactionStatus.CANCELLED],
    ['expire', undefined, GatewayTransactionStatus.EXPIRED],
    ['refund', undefined, GatewayTransactionStatus.REFUNDED],
  ])('%s/%s → %s', (status, fraud, expected) => {
    expect(mapMidtransStatus(status, fraud)).toBe(expected);
  });

  it('capture under fraud review is NOT money', () => {
    expect(mapMidtransStatus('capture', 'challenge')).toBe(GatewayTransactionStatus.AUTHORIZED);
    expect(mapMidtransStatus('capture', 'deny')).toBe(GatewayTransactionStatus.FAILED);
  });

  it('an unknown status is never optimistically treated as paid', () => {
    expect(mapMidtransStatus('something_new')).toBe(GatewayTransactionStatus.PENDING);
    expect(mapMidtransStatus(undefined)).toBe(GatewayTransactionStatus.PENDING);
  });

  it('mapStatus bridges provider vocabulary to the business enum', () => {
    const { p } = provider([{ status: 200, body: {} }]);
    expect(p.mapStatus('settlement')).toBe(PaymentStatus.PAID);
    expect(p.mapStatus('expire')).toBe(PaymentStatus.EXPIRED);
    expect(p.mapStatus('pending')).toBe(PaymentStatus.PENDING);
  });
});

describe('createCharge — per channel', () => {
  it('QRIS: sends payment_type qris and returns a QR instruction', async () => {
    const { p, calls } = provider([{ status: 201, body: pending({ qr_string: 'QR-DATA' }) }]);
    const result = await p.createCharge({ ...REQUEST, channel: 'QRIS' });

    const body = JSON.parse(calls[0].init.body as string);
    expect(calls[0].url).toBe('https://api.sandbox.midtrans.com/v2/charge');
    expect(body.payment_type).toBe('qris');
    expect(body.transaction_details.gross_amount).toBe(130000);
    expect(result.instructions.kind).toBe('QR');
    expect(result.instructions.qrString).toBe('QR-DATA');
    expect(result.providerStatus).toBe(GatewayTransactionStatus.PENDING);
    expect(result.status).toBe(PaymentStatus.PENDING); // never PAID at charge time
    expect(result.providerReference).toBe('trx-9');
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it('GoPay: returns a deeplink action', async () => {
    const { p, calls } = provider([
      { status: 201, body: pending({ payment_type: 'gopay', actions: [{ name: 'deeplink-redirect', url: 'gojek://pay' }] }) },
    ]);
    const result = await p.createCharge({ ...REQUEST, channel: 'GOPAY', channelParams: { callbackUrl: 'https://app/return' } });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.payment_type).toBe('gopay');
    expect(body.gopay).toMatchObject({ enable_callback: true, callback_url: 'https://app/return' });
    expect(result.instructions.kind).toBe('DEEPLINK');
    expect(result.instructions.actionUrl).toBe('gojek://pay');
  });

  it('BCA VA: sends bank_transfer/bca and surfaces the VA number', async () => {
    const { p, calls } = provider([
      { status: 201, body: pending({ payment_type: 'bank_transfer', va_numbers: [{ bank: 'bca', va_number: '8808123456' }] }) },
    ]);
    const result = await p.createCharge({ ...REQUEST, channel: 'BCA_VA' });

    expect(JSON.parse(calls[0].init.body as string).bank_transfer).toEqual({ bank: 'bca' });
    expect(result.instructions.kind).toBe('VA');
    expect(result.instructions.vaNumber).toBe('8808123456');
    expect(result.instructions.howTo.join(' ')).toContain('8808123456');
  });

  it('Mandiri Bill: uses echannel and composes biller:bill key', async () => {
    const { p, calls } = provider([
      { status: 201, body: pending({ payment_type: 'echannel', bill_key: '9911', biller_code: '70012' }) },
    ]);
    const result = await p.createCharge({ ...REQUEST, channel: 'MANDIRI_BILL' });

    expect(JSON.parse(calls[0].init.body as string).echannel).toMatchObject({ bill_info2: 'BMS-20260711-001' });
    expect(result.instructions.vaNumber).toBe('70012:9911');
  });

  it('Credit card: requires a browser token, sends 3DS, and REDACTS the token from rawRequest', async () => {
    const { p: noToken } = provider([{ status: 201, body: pending() }]);
    await expect(noToken.createCharge({ ...REQUEST, channel: 'CREDIT_CARD' })).rejects.toBeInstanceOf(PermanentGatewayError);

    const { p, calls } = provider([
      { status: 201, body: pending({ payment_type: 'credit_card', transaction_status: 'capture', fraud_status: 'accept', redirect_url: 'https://3ds' }) },
    ]);
    const result = await p.createCharge({ ...REQUEST, channel: 'CREDIT_CARD', channelParams: { cardTokenId: 'tok-secret' } });

    expect(JSON.parse(calls[0].init.body as string).credit_card).toMatchObject({ token_id: 'tok-secret', authentication: true });
    expect(result.providerStatus).toBe(GatewayTransactionStatus.CAPTURED);
    expect(JSON.stringify(result.rawRequest)).not.toContain('tok-secret'); // never persisted
    expect(JSON.stringify(result.rawRequest)).toContain('[REDACTED]');
  });

  it('keys each attempt with a unique order_id so a retry cannot double-charge', async () => {
    const { p, calls } = provider([{ status: 201, body: pending() }]);
    await p.createCharge({ ...REQUEST, channel: 'QRIS' });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.transaction_details.order_id).toBe('BMS-20260711-001-a1b2c3d4');
    expect(calls[0].init.headers).toMatchObject({ 'X-Idempotency-Key': 'BMS-20260711-001-a1b2c3d4' });
  });

  it('authenticates with the server key as HTTP Basic username', async () => {
    const { p, calls } = provider([{ status: 201, body: pending() }]);
    await p.createCharge({ ...REQUEST, channel: 'QRIS' });
    const auth = (calls[0].init.headers as Record<string, string>).Authorization;
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe('SB-Mid-server-TEST:');
  });

  it('rejects a channel it does not serve', async () => {
    const { p } = provider([{ status: 201, body: pending() }]);
    await expect(p.createCharge({ ...REQUEST, channel: 'MANUAL_TRANSFER' })).rejects.toBeInstanceOf(PermanentGatewayError);
  });
});

describe('retry strategy', () => {
  it.each(RETRYABLE_STATUSES)('retries on %i and succeeds on the next attempt', async (status) => {
    const { p, http } = provider([{ status, body: { message: 'boom' } }, { status: 201, body: pending() }]);
    const result = await p.createCharge({ ...REQUEST, channel: 'QRIS' });
    expect(http).toHaveBeenCalledTimes(2);
    expect(result.providerReference).toBe('trx-9');
  });

  it('retries a network error / timeout', async () => {
    const { p, http } = provider([new Error('The operation was aborted'), { status: 201, body: pending() }]);
    await p.createCharge({ ...REQUEST, channel: 'QRIS' });
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetry+1 attempts with a TransientGatewayError', async () => {
    const { p, http } = provider([{ status: 503, body: {} }]);
    await expect(p.createCharge({ ...REQUEST, channel: 'QRIS' })).rejects.toBeInstanceOf(TransientGatewayError);
    expect(http).toHaveBeenCalledTimes(3); // maxRetry 2 → 3 attempts
  });

  it('NEVER retries a 4xx decision (400/401/402/404/406)', async () => {
    for (const status of [400, 401, 402, 404, 406]) {
      const { p, http } = provider([{ status, body: { status_message: 'rejected' } }]);
      await expect(p.createCharge({ ...REQUEST, channel: 'QRIS' })).rejects.toBeInstanceOf(PermanentGatewayError);
      expect(http).toHaveBeenCalledTimes(1);
    }
  });

  it('treats a 2xx carrying a 4xx status_code as permanent (Midtrans quirk)', async () => {
    const { p, http } = provider([{ status: 200, body: { status_code: '406', status_message: 'duplicate order_id' } }]);
    await expect(p.createCharge({ ...REQUEST, channel: 'QRIS' })).rejects.toThrow(/406/);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('treats an unparseable 2xx body as permanent, not transient', async () => {
    const p = new MidtransPaymentProvider(CONFIG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.setHttpClient((async () => ({ status: 200, text: async () => '<html>gateway</html>' })) as any);
    await expect(p.createCharge({ ...REQUEST, channel: 'QRIS' })).rejects.toBeInstanceOf(PermanentGatewayError);
  });

  it('honors the configured timeout value on every request', async () => {
    const { p, calls } = provider([{ status: 201, body: pending() }], { ...CONFIG, timeoutMs: 1234 });
    await p.createCharge({ ...REQUEST, channel: 'QRIS' });
    expect(calls[0].init.timeoutMs).toBe(1234);
  });
});

describe('status / cancel / expire', () => {
  it('reads status by the provider reference', async () => {
    const { p, calls } = provider([{ status: 200, body: pending({ transaction_status: 'settlement' }) }]);
    const status = await p.getStatus({ paymentId: 'pay-1', providerReference: 'trx-9' });
    expect(calls[0].url).toContain('/v2/trx-9/status');
    expect(status).toMatchObject({ provider: 'midtrans', providerReference: 'trx-9', status: PaymentStatus.PAID });
  });

  it('cancel and expire hit their endpoints', async () => {
    const cancel = provider([{ status: 200, body: pending({ transaction_status: 'cancel' }) }]);
    await expect(cancel.p.cancel({ paymentId: 'pay-1', providerReference: 'trx-9' })).resolves.toMatchObject({ status: PaymentStatus.FAILED });
    expect(cancel.calls[0].url).toContain('/v2/trx-9/cancel');

    const expire = provider([{ status: 200, body: pending({ transaction_status: 'expire' }) }]);
    await expect(expire.p.expireCharge({ paymentId: 'pay-1', providerReference: 'trx-9' })).resolves.toMatchObject({ status: PaymentStatus.EXPIRED });
    expect(expire.calls[0].url).toContain('/v2/trx-9/expire');
  });

  it('refuses status/cancel/expire without a recorded reference (paymentId means nothing to Midtrans)', async () => {
    const { p, http } = provider([{ status: 200, body: pending() }]);
    const ref = { paymentId: 'pay-1', providerReference: null };
    await expect(p.getStatus(ref)).rejects.toBeInstanceOf(PermanentGatewayError);
    await expect(p.cancel(ref)).rejects.toBeInstanceOf(PermanentGatewayError);
    await expect(p.expireCharge(ref)).rejects.toBeInstanceOf(PermanentGatewayError);
    expect(http).not.toHaveBeenCalled();
  });

  it('refuses any call when the server key is missing', async () => {
    const { p, http } = provider([{ status: 200, body: pending() }], { ...CONFIG, serverKey: undefined });
    await expect(p.createCharge({ ...REQUEST, channel: 'QRIS' })).rejects.toThrow(/MIDTRANS_SERVER_KEY/);
    expect(http).not.toHaveBeenCalled();
  });
});

describe('factory resolution', () => {
  const manualStub = { name: 'manual', supportedChannels: () => ['MANUAL_TRANSFER' as const] };

  it('resolves every gateway channel to Midtrans once registered', () => {
    const { p } = provider([{ status: 200, body: {} }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new PaymentChannelRegistry(new PaymentProviderFactory([manualStub as any, p]));

    for (const channel of midtransSupportedChannels()) {
      expect(registry.resolve(channel).provider.name).toBe('midtrans');
    }
    expect(registry.resolve('MANUAL_TRANSFER').provider.name).toBe('manual');
    expect(registry.listAvailable()).toHaveLength(PAYMENT_CHANNELS.length);
  });

  it('every gateway channel maps to the GATEWAY business method (never a provider name)', () => {
    for (const code of midtransSupportedChannels()) {
      expect(PAYMENT_CHANNELS.find((c) => c.code === code)?.method).toBe(PaymentMethod.GATEWAY);
    }
  });

  it('without Midtrans registered (MIDTRANS_ENABLED=false) gateway channels stay unavailable', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new PaymentChannelRegistry(new PaymentProviderFactory([manualStub as any]));
    expect(registry.listAvailable().map((c) => c.code)).toEqual(['MANUAL_TRANSFER']);
    expect(() => registry.resolve('QRIS')).toThrow();
  });
});
