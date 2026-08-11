import { ValidationPipe } from '@nestjs/common';
import { createHash } from 'crypto';
import { MidtransWebhookDto } from '../../src/modules/payments/gateway/application/dto/midtrans-webhook.dto';
import { PaymentWebhookController } from '../../src/modules/payments/gateway/presentation/payment-webhook.controller';
import { PaymentWebhookService } from '../../src/modules/payments/gateway/payment-webhook.service';
import { MidtransConfig } from '../../src/modules/payments/gateway/midtrans.config';

/**
 * Phase 5H.3 — the REAL Midtrans Sandbox notification.
 *
 * Shape taken verbatim from a genuine QRIS notification that staging rejected with
 * HTTP 400. The root cause was the GLOBAL ValidationPipe in main.ts
 * (`forbidNonWhitelisted: true`), which Nest applies IN ADDITION to any
 * route-scoped pipe: `transaction_type`, `expiry_time` and `customer_details` are
 * real Midtrans fields absent from the DTO, so the request never reached the
 * controller. These tests reproduce that pipeline faithfully.
 */

const SERVER_KEY = 'SB-Mid-server-UNIT-TEST-ONLY'; // fixture, never a real credential
const ORDER_ID = 'SBXTEST-e904ffd31b-7b560320';
const STATUS_CODE = '201';
const GROSS = '40000.00';

const CONFIG: MidtransConfig = {
  enabled: true, serverKey: SERVER_KEY, clientKey: 'ck', isProduction: false,
  baseUrl: 'https://api.sandbox.midtrans.com', timeoutMs: 10_000, maxRetry: 2,
};

/** Independently computed — deliberately not reusing the production helper. */
const signatureOf = (orderId: string, statusCode: string, gross: string, key = SERVER_KEY) =>
  createHash('sha512').update(`${orderId}${statusCode}${gross}${key}`).digest('hex');

/** The exact real payload shape. Sensitive values are fixtures. */
function realNotification(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_type: 'off-us',
    transaction_time: '2026-08-11 08:14:17',
    transaction_status: 'pending',
    transaction_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    status_message: 'midtrans payment notification',
    status_code: STATUS_CODE,
    signature_key: signatureOf(ORDER_ID, STATUS_CODE, GROSS),
    payment_type: 'qris',
    order_id: ORDER_ID,
    merchant_id: 'M365947439',
    gross_amount: GROSS,
    fraud_status: 'accept',
    expiry_time: '2026-08-11 08:29:17',
    customer_details: { full_name: 'Jane', email: 'jane@example.test' },
    currency: 'IDR',
    ...over,
  };
}

/** main.ts, verbatim — the layer that produced the 400. */
const GLOBAL_PIPE = new ValidationPipe({
  whitelist: true, forbidNonWhitelisted: true, transform: true,
  transformOptions: { enableImplicitConversion: true },
});

function controller() {
  const logs = { write: jest.fn() };
  const ledger = {
    findByProviderOrderId: jest.fn().mockResolvedValue(null), // unknown order → safe ack
    recordWebhookNotification: jest.fn(),
    findWebhookEvent: jest.fn(),
    markWebhookSettlementState: jest.fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new PaymentWebhookService(CONFIG, ledger as any, logs as any);
  return { controller: new PaymentWebhookController(service), logs, ledger };
}

// ============================================================ root cause ====

describe('the HTTP 400 root cause', () => {
  it('the GLOBAL pipe rejects the real notification on three genuine Midtrans fields', async () => {
    await expect(
      GLOBAL_PIPE.transform(realNotification(), { type: 'body', metatype: MidtransWebhookDto }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        message: [
          'property transaction_type should not exist',
          'property expiry_time should not exist',
          'property customer_details should not exist',
        ],
      },
    });
  });

  it('the controller parameter is now typed so the global pipe SKIPS it', async () => {
    // ValidationPipe only validates class metatypes; `Object` is passed through.
    // This is what stops main.ts rejecting the body before the controller runs.
    const passthrough = await GLOBAL_PIPE.transform(realNotification(), { type: 'body', metatype: Object });
    expect((passthrough as Record<string, unknown>).transaction_type).toBe('off-us');
    expect((passthrough as Record<string, unknown>).gross_amount).toBe('40000.00');
  });
});

// ====================================================== accepted end to end ==

describe('the real Midtrans notification is accepted', () => {
  it('returns 200 { received: true, handled: false }', async () => {
    const { controller: c } = controller();
    await expect(c.midtrans(realNotification())).resolves.toEqual({ received: true, handled: false });
  });

  it('tolerates channel-specific fields from other payment types', async () => {
    const { controller: c } = controller();

    // Virtual Account
    await expect(c.midtrans(realNotification({
      payment_type: 'bank_transfer',
      va_numbers: [{ bank: 'bca', va_number: '12345678901' }],
      permata_va_number: '8778000000000000',
    }))).resolves.toEqual({ received: true, handled: false });

    // Credit card
    await expect(c.midtrans(realNotification({
      payment_type: 'credit_card',
      masked_card: '481111-1114', card_type: 'credit', bank: 'bni',
      approval_code: '1234567', eci: '05', channel_response_code: '00',
    }))).resolves.toEqual({ received: true, handled: false });

    // A field Midtrans has not invented yet.
    await expect(c.midtrans(realNotification({ some_future_field: 'x' })))
      .resolves.toEqual({ received: true, handled: false });
  });

  it('preserves gross_amount as the EXACT signed string through validation', async () => {
    // "40000.00" must never become 40000 or "40000" — the signature covers the text.
    const { controller: c } = controller();
    const signed = signatureOf(ORDER_ID, STATUS_CODE, '40000.00');
    await expect(c.midtrans(realNotification({ gross_amount: '40000.00', signature_key: signed })))
      .resolves.toEqual({ received: true, handled: false });

    // Proof the string matters: the same amount normalized fails the signature.
    await expect(c.midtrans(realNotification({ gross_amount: '40000', signature_key: signed })))
      .rejects.toMatchObject({ status: 401 });
  });
});

// ======================================================== security boundary ==

describe('the security boundary is unchanged', () => {
  it('an invalid signature is rejected with 401', async () => {
    const { controller: c } = controller();
    await expect(c.midtrans(realNotification({ signature_key: 'f'.repeat(128) })))
      .rejects.toMatchObject({ status: 401 });
  });

  it('a signature computed with the WRONG server key is rejected with 401', async () => {
    const { controller: c } = controller();
    const forged = signatureOf(ORDER_ID, STATUS_CODE, GROSS, 'ATTACKER-KEY');
    await expect(c.midtrans(realNotification({ signature_key: forged })))
      .rejects.toMatchObject({ status: 401 });
  });

  it.each(['signature_key', 'order_id', 'status_code', 'gross_amount'])(
    'a missing %s is still rejected with 400',
    async (field) => {
      const { controller: c } = controller();
      const payload = realNotification();
      delete payload[field];
      await expect(c.midtrans(payload)).rejects.toMatchObject({ status: 400 });
    },
  );

  it('an empty required field is rejected with 400', async () => {
    const { controller: c } = controller();
    await expect(c.midtrans(realNotification({ order_id: '' }))).rejects.toMatchObject({ status: 400 });
  });

  it('validation runs BEFORE the service — a malformed body never reaches it', async () => {
    const { controller: c, ledger } = controller();
    const payload = realNotification();
    delete payload.signature_key;

    await expect(c.midtrans(payload)).rejects.toMatchObject({ status: 400 });
    expect(ledger.findByProviderOrderId).not.toHaveBeenCalled();
  });
});

// ================================================================= logging ==

describe('the notification is never logged in full', () => {
  it('logs correlators only — no signature, key, or customer details', async () => {
    const { controller: c, logs } = controller();
    const payload = realNotification();
    await c.midtrans(payload);

    const written = JSON.stringify(logs.write.mock.calls);
    expect(written).not.toContain(SERVER_KEY);
    expect(written).not.toContain(payload.signature_key as string);
    expect(written).not.toContain('signature_key');
    expect(written).not.toContain('customer_details');
    expect(written).not.toContain('jane@example.test');
    expect(written).not.toContain('Jane');
  });
});
