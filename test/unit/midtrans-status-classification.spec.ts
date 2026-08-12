import { createHash } from 'crypto';
import { GatewayTransactionStatus, PaymentStatus } from '@prisma/client';
import { PermanentGatewayError } from '../../src/modules/payments/gateway/domain/payment-gateway-errors';
import { MidtransPaymentProvider } from '../../src/modules/payments/gateway/infrastructure/providers/midtrans-payment.provider';
import { MidtransConfig } from '../../src/modules/payments/gateway/midtrans.config';
import { GatewayStatusApplier } from '../../src/modules/payments/gateway/gateway-status-applier.service';
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory';
import { PaymentWebhookService } from '../../src/modules/payments/gateway/payment-webhook.service';

/**
 * Phase 5J.7 — Midtrans Status API response classification.
 *
 * THE DEFECT: `assertBodyOk` treated any `status_code` starting with 4 or 5 as a
 * transport failure. That is right for /v2/charge, where `status_code` is the
 * REQUEST outcome — but wrong for /v2/{id}/status, where it carries the
 * TRANSACTION STATE. An expired charge answers:
 *
 *   HTTP 200  status_code "407"  status_message "Success, transaction is found"
 *             transaction_status "expire"
 *
 * ...which was classified as a PermanentGatewayError, so `transaction_status` was
 * never read, the webhook returned 503, and NO gateway payment could ever reach
 * EXPIRED — through the webhook or the reconciliation worker.
 *
 * The body below is the shape observed from the real Midtrans Sandbox for
 * BMS-20260812-KAJ5A65C-ca35b81c. Amounts/ids are the real transaction's; no
 * credential appears anywhere in this file.
 */

const SERVER_KEY = 'SB-Mid-server-UNIT-TEST-ONLY'; // fixture, never a real credential
const ORDER_ID = 'BMS-20260812-KAJ5A65C-ca35b81c';
const GROSS = '210000.00';
const GROSS_RUPIAH = 210000;

const CONFIG: MidtransConfig = {
  enabled: true,
  serverKey: SERVER_KEY,
  clientKey: 'ck',
  isProduction: false,
  baseUrl: 'https://api.sandbox.midtrans.com',
  timeoutMs: 5000,
  maxRetry: 2,
};

/** Scripted transport — no real HTTP ever leaves this test. */
function provider(body: unknown, status = 200) {
  const p = new MidtransPaymentProvider(CONFIG);
  const http = jest.fn(async () => ({ status, text: async () => JSON.stringify(body) }));
  p.setHttpClient(http as never);
  return { p, http };
}

/** The verbatim shape Midtrans returns for an EXPIRED QRIS charge. */
const expiredStatusBody = (over: Record<string, unknown> = {}) => ({
  status_code: '407',
  status_message: 'Success, transaction is found',
  transaction_id: '2f18cccf-6a4a-47b0-8b7f-60f95c3246e7',
  order_id: ORDER_ID,
  transaction_status: 'expire',
  fraud_status: 'accept',
  payment_type: 'qris',
  gross_amount: GROSS,
  currency: 'IDR',
  transaction_time: '2026-08-12 08:32:35',
  expiry_time: '2026-08-12 08:47:35',
  merchant_id: 'M365947439',
  ...over,
});

const ref = { paymentId: 'pay-1', providerReference: ORDER_ID };

// ================================================ 1-6: the status endpoint ===

describe('Status API: a lookup that succeeds is never a transport failure', () => {
  it.each([
    ['200', 'settlement', PaymentStatus.PAID],
    ['201', 'pending', PaymentStatus.PENDING],
    ['407', 'expire', PaymentStatus.EXPIRED],
    ['202', 'deny', PaymentStatus.FAILED],
  ])('status_code %s + transaction_status %s → success', async (statusCode, txStatus, expected) => {
    const { p } = provider(expiredStatusBody({ status_code: statusCode, transaction_status: txStatus }));
    await expect(p.getStatus(ref)).resolves.toMatchObject({ provider: 'midtrans', status: expected });
  });

  it('THE REGRESSION: 407 "Success, transaction is found" no longer throws', async () => {
    const { p } = provider(expiredStatusBody());
    // Before the fix this rejected with:
    //   PermanentGatewayError: midtrans status_code 407: Success, transaction is found
    await expect(p.getStatus(ref)).resolves.toBeDefined();
    await expect(p.getStatus(ref)).resolves.not.toBeInstanceOf(PermanentGatewayError);
  });

  it('maps the real expired response to EXPIRED and preserves the raw body', async () => {
    const { p } = provider(expiredStatusBody());
    const status = await p.getStatus(ref);

    expect(status.status).toBe(PaymentStatus.EXPIRED);
    expect(status.providerReference).toBe('2f18cccf-6a4a-47b0-8b7f-60f95c3246e7');
    // The applier re-verifies the raw body, so it must survive untouched.
    expect(status.raw).toMatchObject({ order_id: ORDER_ID, transaction_status: 'expire', gross_amount: GROSS });
  });

  it('queries the status endpoint on the configured sandbox base URL', async () => {
    const { p, http } = provider(expiredStatusBody());
    await p.getStatus(ref);
    expect(http).toHaveBeenCalledWith(
      `${CONFIG.baseUrl}/v2/${encodeURIComponent(ORDER_ID)}/status`,
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

// ================================================ 7-8: charge is unchanged ===

describe('charge classification is untouched', () => {
  it('a rejected charge with a 4xx status_code and no transaction_status still throws', async () => {
    const { p } = provider({ status_code: '402', status_message: 'Transaction is not authorized' });
    await expect(
      p.createCharge({
        paymentId: 'pay-1', orderId: 'o-1', orderNumber: 'BMS-1', amount: 130000,
        channel: 'QRIS', customer: { name: null, email: null, phone: null }, attemptId: 'a1b2c3d4',
      } as never),
    ).rejects.toBeInstanceOf(PermanentGatewayError);
  });

  it('a 5xx status_code with no transaction_status still throws', async () => {
    const { p } = provider({ status_code: '500', status_message: 'Internal error' });
    await expect(p.getStatus(ref)).rejects.toBeInstanceOf(PermanentGatewayError);
  });

  it('a successful charge (201 + pending) is unaffected', async () => {
    const { p } = provider({
      status_code: '201', transaction_status: 'pending', transaction_id: 'trx-9',
      order_id: 'BMS-1-a1b2c3d4', payment_type: 'qris', gross_amount: '130000.00',
      qr_string: 'QR-DATA', expiry_time: '2026-08-12 10:00:00',
    });
    await expect(
      p.createCharge({
        paymentId: 'pay-1', orderId: 'o-1', orderNumber: 'BMS-1', amount: 130000,
        channel: 'QRIS', customer: { name: null, email: null, phone: null }, attemptId: 'a1b2c3d4',
      } as never),
    ).resolves.toMatchObject({ provider: 'midtrans', channel: 'QRIS' });
  });
});

// ========================================== 9: malformed responses are safe ==

describe('a malformed status response fails safely', () => {
  it('HTTP 200 with NO transaction_status throws instead of defaulting to PENDING', async () => {
    // Silently mapping this would invent a state we never received.
    const { p } = provider({ status_code: '200', status_message: 'Success' });
    await expect(p.getStatus(ref)).rejects.toBeInstanceOf(PermanentGatewayError);
    await expect(p.getStatus(ref)).rejects.toThrow(/no transaction_status/);
  });

  it('an empty transaction_status is not accepted as a state', async () => {
    const { p } = provider({ status_code: '200', transaction_status: '' });
    await expect(p.getStatus(ref)).rejects.toThrow(/no transaction_status/);
  });

  it('cancel and expire endpoints get the same protection', async () => {
    const { p } = provider({ status_code: '200', status_message: 'Success' });
    await expect(p.cancel(ref)).rejects.toThrow(/no transaction_status/);
    await expect(p.expireCharge!(ref)).rejects.toThrow(/no transaction_status/);
  });
});

// ============================================ 10: webhook reaches settlement =

describe('the expire notification now settles instead of 503-ing', () => {
  const signatureOf = (orderId: string, statusCode: string, gross: string) =>
    createHash('sha512').update(`${orderId}${statusCode}${gross}${SERVER_KEY}`).digest('hex');

  /** Real provider + real applier; only the ledger and the state machine are doubled. */
  function world() {
    const { p } = provider(expiredStatusBody());
    const providers = new PaymentProviderFactory([p]);

    const settlement = {
      settle: jest.fn(),
      fail: jest.fn(),
      expire: jest.fn().mockResolvedValue({ result: 'APPLIED', payment: { id: 'pay-1', status: PaymentStatus.EXPIRED } }),
    };
    const applier = new GatewayStatusApplier(settlement as never);

    const transaction = {
      id: 'gtx-1',
      paymentId: 'pay-1',
      provider: 'midtrans',
      providerOrderId: ORDER_ID,
      providerTransactionId: '2f18cccf-6a4a-47b0-8b7f-60f95c3246e7',
      grossAmount: GROSS_RUPIAH,
      status: GatewayTransactionStatus.PENDING,
    };

    const ledger = {
      findByProviderOrderId: jest.fn().mockResolvedValue(transaction),
      recordWebhookNotification: jest.fn().mockResolvedValue('applied'),
      findWebhookEvent: jest.fn().mockResolvedValue({ settlementState: 'RECEIVED' }),
      markWebhookSettlementState: jest.fn().mockResolvedValue(undefined),
      // Must never be called by a webhook — a notification opens no new attempt.
      createPendingTransaction: jest.fn(),
      updateGatewayResponse: jest.fn(),
    };

    const svc = new PaymentWebhookService(CONFIG, ledger as never, { write: jest.fn() } as never, applier, providers);
    return { svc, ledger, settlement, transaction };
  }

  const expireNotification = () => ({
    order_id: ORDER_ID,
    status_code: '202',
    gross_amount: GROSS,
    signature_key: signatureOf(ORDER_ID, '202', GROSS),
    transaction_id: '2f18cccf-6a4a-47b0-8b7f-60f95c3246e7',
    transaction_status: 'expire',
    payment_type: 'qris',
  }) as never;

  it('does NOT throw ServiceUnavailable, and drives settlement.expire()', async () => {
    const { svc, settlement } = world();

    // Before the fix this rejected with 503 "Payment status could not be verified".
    await expect(svc.handleMidtransNotification(expireNotification())).resolves.toMatchObject({
      settlement: 'expired',
    });

    expect(settlement.expire).toHaveBeenCalledTimes(1);
    expect(settlement.expire).toHaveBeenCalledWith('pay-1', expect.objectContaining({ kind: 'GATEWAY' }), expect.any(String));
    expect(settlement.settle).not.toHaveBeenCalled();
    expect(settlement.fail).not.toHaveBeenCalled();
  });

  it('creates no second attempt and never mutates the existing one', async () => {
    const { svc, ledger, transaction } = world();
    await svc.handleMidtransNotification(expireNotification());

    expect(ledger.createPendingTransaction).not.toHaveBeenCalled();
    expect(ledger.updateGatewayResponse).not.toHaveBeenCalled();
    expect(transaction.providerOrderId).toBe(ORDER_ID);
    expect(transaction.id).toBe('gtx-1');
  });

  it('still refuses to trust the notification body — the Status API decides', async () => {
    // The body claims `settlement`, but the authoritative status says `expire`.
    const { svc, settlement } = world();
    const lying = { ...(expireNotification() as object), transaction_status: 'settlement' } as never;

    await svc.handleMidtransNotification(lying);

    expect(settlement.expire).toHaveBeenCalledTimes(1); // followed the Status API
    expect(settlement.settle).not.toHaveBeenCalled(); // NOT the body
  });
});

// ============================================== 11: reconciliation recovers ==

describe('the reconciliation worker reads the same status successfully', () => {
  it('resolves the provider from the factory and receives EXPIRED, not an error', async () => {
    // midtrans-reconciliation.worker.ts calls providers.get('midtrans').getStatus(...)
    // with exactly this shape; the defect broke that path identically.
    const { p } = provider(expiredStatusBody());
    const resolved = new PaymentProviderFactory([p]).get('midtrans');

    await expect(
      resolved!.getStatus({ paymentId: 'pay-1', providerReference: ORDER_ID }),
    ).resolves.toMatchObject({ status: PaymentStatus.EXPIRED });
  });
});
