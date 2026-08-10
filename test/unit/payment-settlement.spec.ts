import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { GatewayTransactionStatus, PaymentStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { MidtransWebhookDto } from '../../src/modules/payments/gateway/application/dto/midtrans-webhook.dto';
import {
  parseMidtransAmountToRupiah,
  verifyMidtransStatusResponse,
} from '../../src/modules/payments/gateway/domain/midtrans-status-verification.util';
import { MidtransConfig } from '../../src/modules/payments/gateway/midtrans.config';
import { PaymentWebhookService } from '../../src/modules/payments/gateway/payment-webhook.service';
import { GatewayStatusApplier } from '../../src/modules/payments/gateway/gateway-status-applier.service';
import { PaymentSettlementService } from '../../src/modules/payments/settlement/payment-settlement.service';

const SERVER_KEY = 'SB-Mid-server-SECRET-KEY';
const PROVIDER_ORDER_ID = 'BMS-20260712-001-aaaaaaaa';
const GROSS = '130000.00';
const AMOUNT = 130000;
const GTX_ID = 'gtx-1';
const PAYMENT_ID = 'pay-1';

const CONFIG: MidtransConfig = {
  enabled: true, serverKey: SERVER_KEY, clientKey: 'ck', isProduction: false,
  baseUrl: 'https://api.sandbox.midtrans.com', timeoutMs: 5000, maxRetry: 2,
};

const signatureOf = (orderId: string, statusCode: string, gross: string) =>
  createHash('sha512').update(`${orderId}${statusCode}${gross}${SERVER_KEY}`).digest('hex');

function notification(over: Partial<MidtransWebhookDto> = {}): MidtransWebhookDto {
  return {
    order_id: PROVIDER_ORDER_ID,
    status_code: '200',
    gross_amount: GROSS,
    signature_key: signatureOf(PROVIDER_ORDER_ID, over.status_code ?? '200', over.gross_amount ?? GROSS),
    transaction_id: 'trx-authoritative',
    transaction_status: 'settlement',
    payment_type: 'qris',
    ...over,
  } as MidtransWebhookDto;
}

/** What the Midtrans Status API returns — the ONLY thing allowed to move money. */
const statusBody = (over: Record<string, unknown> = {}) => ({
  order_id: PROVIDER_ORDER_ID,
  transaction_status: 'settlement',
  status_code: '200',
  gross_amount: GROSS,
  transaction_id: 'trx-authoritative',
  ...over,
});

interface HarnessOpts {
  statusApi?: Record<string, unknown> | (() => never);
  statusThrows?: Error;
  settleResult?: 'SETTLED' | 'ALREADY_PAID';
  settleThrows?: Error;
  recordedState?: string;
  transaction?: Record<string, unknown> | null;
}

function harness(opts: HarnessOpts = {}) {
  const logs = { write: jest.fn() };

  const ledger = {
    findByProviderOrderId: jest.fn().mockResolvedValue(
      opts.transaction === undefined
        ? { id: GTX_ID, paymentId: PAYMENT_ID, providerOrderId: PROVIDER_ORDER_ID, providerTransactionId: null, grossAmount: AMOUNT }
        : opts.transaction,
    ),
    recordWebhookNotification: jest.fn().mockResolvedValue('applied'),
    findWebhookEvent: jest.fn().mockResolvedValue({ settlementState: opts.recordedState ?? 'RECEIVED' }),
    markWebhookSettlementState: jest.fn().mockResolvedValue(undefined),
  };

  const getStatus = jest.fn(async () => {
    if (opts.statusThrows) throw opts.statusThrows;
    return { provider: 'midtrans', providerReference: 'x', status: PaymentStatus.PAID, raw: opts.statusApi ?? statusBody() };
  });
  const providers = { get: jest.fn().mockReturnValue({ name: 'midtrans', getStatus }) };

  const payment = { id: PAYMENT_ID, orderId: 'ord-1', status: PaymentStatus.PAID };
  const settle = jest.fn(async () => {
    if (opts.settleThrows) throw opts.settleThrows;
    return { result: opts.settleResult ?? 'SETTLED', payment };
  });
  const fail = jest.fn(async () => ({ result: 'APPLIED', payment }));
  const expire = jest.fn(async () => ({ result: 'APPLIED', payment }));
  const settlement = { settle, fail, expire };

  // Phase 5E: the webhook reaches the state machine through the shared applier,
  // so the harness wires the REAL applier over the settlement double.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applier = new GatewayStatusApplier(settlement as any, logs as any);

  const svc = new PaymentWebhookService(
    CONFIG,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ledger as any, logs as any, applier as any, providers as any,
  );
  return { svc, ledger, logs, settle, fail, expire, getStatus, providers };
}

// ============================================ status response verification ==

describe('verifyMidtransStatusResponse (§17)', () => {
  it('accepts a well-formed settlement for the correlated order and amount', () => {
    const v = verifyMidtransStatusResponse(statusBody(), PROVIDER_ORDER_ID, AMOUNT);
    expect(v).toMatchObject({ ok: true, gatewayStatus: GatewayTransactionStatus.SETTLEMENT, paymentStatus: PaymentStatus.PAID });
  });

  it('refuses a response describing a DIFFERENT order', () => {
    const v = verifyMidtransStatusResponse(statusBody({ order_id: 'SOMEONE-ELSE' }), PROVIDER_ORDER_ID, AMOUNT);
    expect(v).toEqual({ ok: false, reason: 'order_id_mismatch' });
  });

  it('refuses an amount that is not what we are owed', () => {
    const v = verifyMidtransStatusResponse(statusBody({ gross_amount: '1000.00' }), PROVIDER_ORDER_ID, AMOUNT);
    expect(v).toEqual({ ok: false, reason: 'amount_mismatch' });
  });

  it.each([
    ['null body', null],
    ['a string body', 'settlement'],
    ['missing transaction_status', statusBody({ transaction_status: undefined })],
    ['missing status_code', statusBody({ status_code: undefined })],
    ['missing gross_amount', statusBody({ gross_amount: undefined })],
    ['missing order_id', statusBody({ order_id: undefined })],
    ['non-numeric amount', statusBody({ gross_amount: 'lots' })],
    ['settled money with no transaction_id', statusBody({ transaction_id: undefined })],
  ])('refuses %s as malformed', (_label, body) => {
    expect(verifyMidtransStatusResponse(body, PROVIDER_ORDER_ID, AMOUNT)).toEqual({ ok: false, reason: 'malformed_response' });
  });

  it('parses rupiah exactly — sub-rupiah precision is never rounded away', () => {
    expect(parseMidtransAmountToRupiah('130000.00')).toBe(130000);
    expect(parseMidtransAmountToRupiah('130000')).toBe(130000);
    expect(parseMidtransAmountToRupiah('130000.50')).toBeNull(); // real fraction → refuse
    expect(parseMidtransAmountToRupiah('1e5')).toBeNull();
    expect(parseMidtransAmountToRupiah('-100')).toBeNull();
  });

  // §18 — credit card fraud states, using the EXISTING mapper.
  it('capture + accept is PAID', () => {
    const v = verifyMidtransStatusResponse(
      statusBody({ transaction_status: 'capture', fraud_status: 'accept' }), PROVIDER_ORDER_ID, AMOUNT);
    expect(v).toMatchObject({ ok: true, gatewayStatus: GatewayTransactionStatus.CAPTURED, paymentStatus: PaymentStatus.PAID });
  });

  it('capture + challenge is NOT paid — it is money held for review', () => {
    const v = verifyMidtransStatusResponse(
      statusBody({ transaction_status: 'capture', fraud_status: 'challenge' }), PROVIDER_ORDER_ID, AMOUNT);
    expect(v).toMatchObject({ ok: true, gatewayStatus: GatewayTransactionStatus.AUTHORIZED, paymentStatus: PaymentStatus.PENDING });
  });

  it('capture + deny is FAILED', () => {
    const v = verifyMidtransStatusResponse(
      statusBody({ transaction_status: 'capture', fraud_status: 'deny' }), PROVIDER_ORDER_ID, AMOUNT);
    expect(v).toMatchObject({ ok: true, gatewayStatus: GatewayTransactionStatus.FAILED, paymentStatus: PaymentStatus.FAILED });
  });

  it('an unknown status word is never optimistically treated as paid', () => {
    const v = verifyMidtransStatusResponse(
      statusBody({ transaction_status: 'quantum_superposition' }), PROVIDER_ORDER_ID, AMOUNT);
    expect(v).toMatchObject({ ok: true, paymentStatus: PaymentStatus.PENDING });
  });
});

// ================================= webhook body is NEVER the source of truth ==

describe('Settlement authority — the webhook body cannot move money', () => {
  it('webhook says settlement but Status API says pending → stays PENDING', async () => {
    const h = harness({ statusApi: statusBody({ transaction_status: 'pending', status_code: '201' }) });
    const result = await h.svc.handleMidtransNotification(notification({ transaction_status: 'settlement' }));

    expect(result.settlement).toBe('not_eligible');
    expect(h.settle).not.toHaveBeenCalled(); // no PAID, no order move, no inventory,
    expect(h.ledger.markWebhookSettlementState).toHaveBeenCalledWith(expect.any(String), 'NOT_ELIGIBLE');
  });

  it('webhook says pending but Status API says settlement → PAID (authority wins)', async () => {
    const h = harness({ statusApi: statusBody({ transaction_status: 'settlement' }) });
    const result = await h.svc.handleMidtransNotification(notification({ transaction_status: 'pending', status_code: '201' }));

    expect(result.settlement).toBe('settled');
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it('the settlement decision reads the STATUS API status, never the webhook field', async () => {
    const h = harness({ statusApi: statusBody({ transaction_status: 'settlement', transaction_id: 'authoritative-id' }) });
    await h.svc.handleMidtransNotification(notification({ transaction_status: 'capture', transaction_id: 'forged-id' }));

    expect(h.settle).toHaveBeenCalledWith(PAYMENT_ID, expect.objectContaining({
      kind: 'GATEWAY',
      providerStatus: 'settlement',      // from the Status API
      providerTransactionId: 'authoritative-id', // from the Status API
      gatewayStatus: GatewayTransactionStatus.SETTLEMENT,
    }));
  });

  it('a forged unsigned transaction_status cannot settle an unpaid order', async () => {
    // Signature covers order_id+status_code+gross_amount only, so this body is
    // perfectly valid — and still cannot settle, because the API says otherwise.
    const h = harness({ statusApi: statusBody({ transaction_status: 'deny' }) });
    const result = await h.svc.handleMidtransNotification(notification({ transaction_status: 'settlement' }));

    // Phase 5E routes `deny` to the existing FAILED path — but never to PAID.
    expect(result.settlement).toBe('failed');
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.fail).toHaveBeenCalledTimes(1);
  });

  it('signature is verified BEFORE the Status API is ever called', async () => {
    const h = harness();
    await h.svc.handleMidtransNotification(notification({ signature_key: 'f'.repeat(128) })).catch(() => undefined);

    expect(h.providers.get).not.toHaveBeenCalled();
    expect(h.getStatus).not.toHaveBeenCalled(); // an invalid webhook cannot probe Midtrans
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('the Status API is queried with the Phase 5A provider order id', async () => {
    const h = harness();
    await h.svc.handleMidtransNotification(notification());
    expect(h.getStatus).toHaveBeenCalledWith({ paymentId: PAYMENT_ID, providerReference: PROVIDER_ORDER_ID });
  });
});

// ================================================== status API unavailable ==

describe('Status API failure (§3) — never mutate, always retryable', () => {
  const failures: Array<[string, Error]> = [
    ['timeout', Object.assign(new Error('timeout of 5000ms exceeded'), { name: 'TimeoutError' })],
    ['429', Object.assign(new Error('429 Too Many Requests'), { name: 'TransientGatewayError' })],
    ['5xx', Object.assign(new Error('502 Bad Gateway'), { name: 'TransientGatewayError' })],
    ['malformed transport', Object.assign(new Error('Unexpected token < in JSON'), { name: 'SyntaxError' })],
  ];

  it.each(failures)('%s → no mutation, 503 so Midtrans redelivers', async (_label, err) => {
    const h = harness({ statusThrows: err });
    await expect(h.svc.handleMidtransNotification(notification())).rejects.toThrow(ServiceUnavailableException);

    expect(h.settle).not.toHaveBeenCalled();
    // Recorded as NOT-processed, so the redelivery is allowed to try again.
    expect(h.ledger.markWebhookSettlementState).toHaveBeenCalledWith(expect.any(String), 'VERIFICATION_FAILED');
  });

  it('a VERIFICATION_FAILED notification is re-processable on redelivery', async () => {
    // The redelivery finds the same fingerprint but a non-terminal state, so it does
    // NOT short-circuit as a duplicate — it retries and settles.
    const h = harness({ recordedState: 'VERIFICATION_FAILED' });
    const result = await h.svc.handleMidtransNotification(notification());

    expect(result.settlement).toBe('settled');
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it('malformed Status API data → no mutation', async () => {
    const h = harness({ statusApi: { nonsense: true } as Record<string, unknown> });
    const result = await h.svc.handleMidtransNotification(notification());

    expect(result.settlement).toBe('not_eligible');
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('order_id mismatch → no settlement, safe anomaly log only', async () => {
    const h = harness({ statusApi: statusBody({ order_id: 'ANOTHER-ORDER' }) });
    const result = await h.svc.handleMidtransNotification(notification());

    expect(result.settlement).toBe('not_eligible');
    expect(h.settle).not.toHaveBeenCalled();
    const anomaly = h.logs.write.mock.calls.map((c) => c[0]).find((e) => e.action === 'midtrans.status_anomaly');
    expect(anomaly.metadata.reason).toBe('order_id_mismatch');
  });

  it('gross_amount mismatch → no settlement', async () => {
    const h = harness({ statusApi: statusBody({ gross_amount: '10.00' }) });
    const result = await h.svc.handleMidtransNotification(notification());

    expect(result.settlement).toBe('not_eligible');
    expect(h.settle).not.toHaveBeenCalled();
  });
});

// ========================================================= idempotency ======

describe('Idempotency (§9) — duplicates cause no second business effect', () => {
  it('a notification already SETTLED short-circuits before the Status API', async () => {
    const h = harness({ recordedState: 'SETTLED' });
    const result = await h.svc.handleMidtransNotification(notification());

    expect(result.settlement).toBe('already_processed');
    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled(); // no re-transition, no second event
  });

  it('a notification already NOT_ELIGIBLE short-circuits too', async () => {
    const h = harness({ recordedState: 'NOT_ELIGIBLE' });
    expect((await h.svc.handleMidtransNotification(notification())).settlement).toBe('already_processed');
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('even if a duplicate DID reach settlement, the payment CAS makes it a no-op', async () => {
    // Belt and braces: the fingerprint is one guard, the state machine is the other.
    const h = harness({ recordedState: 'RECEIVED', settleResult: 'ALREADY_PAID' });
    const result = await h.svc.handleMidtransNotification(notification());

    expect(result.settlement).toBe('already_terminal');
    // ALREADY_PAID emits no event, commits no inventory and books no shipment —
    // that is enforced inside PaymentSettlementService (see its own tests).
  });

  it('concurrent identical deliveries settle at most once', async () => {
    const h = harness();
    let settled = 0;
    h.settle.mockImplementation(async () => {
      // Mirrors the CAS: the first caller flips the row, the rest are refused.
      if (settled++ > 0) throw new ConflictException('Payment already verified or rejected');
      return { result: 'SETTLED', payment: { id: PAYMENT_ID, orderId: 'ord-1', status: PaymentStatus.PAID } };
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.svc.handleMidtransNotification(notification()).catch((e: Error) => e)),
    );
    const outcomes = results.map((r) => (r instanceof Error ? 'threw' : r.settlement));

    expect(outcomes.filter((o) => o === 'settled')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'threw')).toHaveLength(0); // conflicts are conclusions
  });
});

// ======================================== illegal transitions / resurrection ==

describe('Legal transitions (§19) — nothing is resurrected', () => {
  it('a terminal (EXPIRED) payment is refused, acknowledged, and NOT retried forever', async () => {
    const h = harness({ settleThrows: new ConflictException('Payment cannot be verified from terminal status EXPIRED') });
    const result = await h.svc.handleMidtransNotification(notification());

    expect(result.settlement).toBe('illegal_transition');
    // Marked terminal: retrying can never change a terminal payment, so this is a
    // conclusion, not a failure — no infinite redelivery.
    expect(h.ledger.markWebhookSettlementState).toHaveBeenCalledWith(expect.any(String), 'NOT_ELIGIBLE');
  });

  it('a CANCELLED order is refused with no resurrection', async () => {
    const h = harness({ settleThrows: new ConflictException('Order is cancelled; the payment can no longer be verified') });
    const result = await h.svc.handleMidtransNotification(notification());

    expect(result.settlement).toBe('illegal_transition');
    const refused = h.logs.write.mock.calls.map((c) => c[0]).find((e) => e.action === 'gateway.apply.illegal_transition');
    expect(refused.metadata.result).toBe('illegal_transition');
  });

  it('a rollback (non-conflict failure) stays re-processable and surfaces', async () => {
    const h = harness({ settleThrows: new Error('deadlock detected; transaction rolled back') });
    await expect(h.svc.handleMidtransNotification(notification())).rejects.toThrow('deadlock');

    // Not marked done: nothing partial committed, so the redelivery must retry.
    expect(h.ledger.markWebhookSettlementState).toHaveBeenCalledWith(expect.any(String), 'VERIFICATION_FAILED');
  });

  it('an unknown transaction never reaches the Status API or settlement', async () => {
    const h = harness({ transaction: null });
    const result = await h.svc.handleMidtransNotification(notification());

    expect(result).toEqual({ outcome: 'unknown_transaction', settlement: 'skipped' });
    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
  });
});

// =============================================================== security ====

describe('Observability (§21) — secrets never reach a log', () => {
  it('never logs the server key, signature, or the raw gateway response', async () => {
    const h = harness({ statusApi: statusBody({ card_token: 'tok_secret', masked_card: '4811-1111' }) });
    const dto = notification();
    await h.svc.handleMidtransNotification(dto);

    const written = JSON.stringify(h.logs.write.mock.calls);
    expect(written).not.toContain(SERVER_KEY);
    expect(written).not.toContain(dto.signature_key);
    expect(written).not.toContain('signature_key');
    expect(written).not.toContain('tok_secret'); // raw response never logged
    expect(written).not.toContain('Authorization');
    expect(written).not.toContain('Basic ');
  });

  it('logs only the allowlisted settlement correlators', async () => {
    const h = harness();
    await h.svc.handleMidtransNotification(notification());
    const settled = h.logs.write.mock.calls.map((c) => c[0]).find((e) => e.action === 'gateway.apply.settled');

    expect(Object.keys(settled.metadata).sort()).toEqual(
      ['provider', 'providerOrderId', 'providerStatus', 'providerTransactionId', 'reason', 'result', 'source'].sort(),
    );
  });

  it('a Status API failure logs a class of error, never the response or headers', async () => {
    const h = harness({ statusThrows: Object.assign(new Error(`Basic ${SERVER_KEY} rejected`), { name: 'TransientGatewayError' }) });
    await h.svc.handleMidtransNotification(notification()).catch(() => undefined);

    const written = JSON.stringify(h.logs.write.mock.calls);
    expect(written).not.toContain(SERVER_KEY); // the message itself is NOT logged
    expect(written).toContain('TransientGatewayError');
  });
});

// ============================================== the shared settlement path ===

describe('PaymentSettlementService — one state machine for both actors', () => {
  it('exposes the same transition to admin and gateway callers', () => {
    // If a second settlement path is ever added, this is the assertion that fails:
    // there is exactly one public entry point.
    const surface = Object.getOwnPropertyNames(PaymentSettlementService.prototype)
      .filter((m) => m !== 'constructor' && !m.startsWith('_'));
    expect(surface).toEqual(['settle', 'fail', 'expire', 'recordGatewayState', 'note', 'source']);
  });

  it('builds payment.paid through the shared envelope builder, not by hand', () => {
    const src = PaymentSettlementService.prototype.settle.toString();
    expect(src).toContain('buildOutboxEvent');
    expect(src).toContain("eventName: 'payment.paid'");
    // No hand-rolled envelope fields (H2 owns id/eventVersion/occurredAt).
    expect(src).not.toContain('eventVersion:');
    expect(src).not.toMatch(/id:\s*randomUUID/);
  });

  it('commits inventory through the existing reservation path only', () => {
    const src = PaymentSettlementService.prototype.settle.toString();
    expect(src).toContain('commitForOrder');
    expect(src).not.toContain('product.update'); // never a direct stock write
    expect(src).not.toContain('decrement');
  });

  it('books the shipment through the existing idempotent path, after commit', () => {
    const src = PaymentSettlementService.prototype.settle.toString();
    expect(src).toContain('createForOrderSafe');
    // Exactly one call site → one settled payment books at most once.
    expect(src.match(/createForOrderSafe/g)).toHaveLength(1);
  });

  it('never calls a notification provider directly', () => {
    const src = PaymentSettlementService.prototype.settle.toString();
    for (const banned of ['whatsapp', 'qontak', 'sendMail', 'notificationSender', 'email']) {
      expect(src.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it('guards the order transition with FOR UPDATE and the payment with CAS', () => {
    const src = PaymentSettlementService.prototype.settle.toString();
    expect(src).toContain('FOR UPDATE');
    expect(src).toContain('TERMINAL_PAYMENT_STATUSES');
    expect(src).toContain('OrderStatus.CANCELLED');
  });
});

// ============================================ atomicity & rollback (§5, §20) ==

/**
 * Exercises the real `settle()` against a Prisma double whose `$transaction`
 * propagates failures and discards everything written inside on throw — i.e. it
 * models rollback. This proves the ORDERING and the all-or-nothing property without
 * Docker; the same guarantees are asserted against real MySQL in
 * test/integration/payment-settlement.int-spec.ts (not run here — see the report).
 */
describe('PaymentSettlementService — atomicity and rollback', () => {
  // The doubles below are shape-checked by the assertions, not by the compiler.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Any = any;

  interface Behaviour {
    paymentStatus?: PaymentStatus;
    orderStatus?: string;
    orderFlipThrows?: Error;
    inventoryThrows?: Error;
    outboxThrows?: Error;
  }

  function build(b: Behaviour = {}) {
    const committed: string[] = [];
    const attempted: string[] = [];

    const tx = {
      payment: {
        updateMany: jest.fn(async () => { attempted.push('payment.PAID'); return { count: 1 }; }),
        findUniqueOrThrow: jest.fn(async () => ({ id: PAYMENT_ID, orderId: 'ord-1', amount: AMOUNT, verifiedByUserId: null })),
      },
      $queryRaw: jest.fn(async () => [{ status: b.orderStatus ?? 'PENDING' }]),
      order: {
        updateMany: jest.fn(async () => {
          if (b.orderFlipThrows) throw b.orderFlipThrows;
          attempted.push('order.PROCESSING');
          return { count: 1 };
        }),
      },
      orderEvent: { create: jest.fn(async (_args: Any) => { attempted.push('orderEvent'); return {}; }) },
      paymentGatewayTransaction: { updateMany: jest.fn(async (_args: Any) => { attempted.push('gateway'); return { count: 1 }; }) },
      auditLog: { create: jest.fn(async (_args: Any) => { attempted.push('audit'); return {}; }) },
      outboxEvent: {
        create: jest.fn(async (_args: Any) => {
          if (b.outboxThrows) throw b.outboxThrows;
          attempted.push('outbox.payment.paid');
          return {};
        }),
      },
    };

    const prisma = {
      payment: {
        findUnique: jest.fn(async () => ({
          id: PAYMENT_ID, orderId: 'ord-1', amount: AMOUNT,
          status: b.paymentStatus ?? PaymentStatus.PENDING, deletedAt: null,
        })),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
        const out = await fn(tx); // a throw here propagates: NOTHING is committed
        committed.push(...attempted);
        return out;
      }),
    };

    const inventory = {
      commitForOrder: jest.fn(async () => {
        if (b.inventoryThrows) throw b.inventoryThrows;
        attempted.push('inventory.commit');
        return 2;
      }),
    };
    const shipments = { createForOrderSafe: jest.fn(async () => undefined) };

    const svc = new PaymentSettlementService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any, shipments as any, inventory as any,
    );
    return { svc, prisma, tx, inventory, shipments, committed, attempted };
  }

  const gatewayActor = {
    kind: 'GATEWAY' as const,
    provider: 'midtrans',
    providerStatus: 'settlement',
    providerTransactionId: 'trx-authoritative',
    gatewayTransactionId: GTX_ID,
    gatewayStatus: GatewayTransactionStatus.SETTLEMENT,
  };

  it('commits payment, order, inventory, gateway, audit and the event in ONE transaction', async () => {
    const h = build();
    const out = await h.svc.settle(PAYMENT_ID, gatewayActor);

    expect(out.result).toBe('SETTLED');
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1); // not three separate ones
    expect(h.committed).toEqual([
      'payment.PAID', 'order.PROCESSING', 'orderEvent', 'inventory.commit', 'gateway', 'audit', 'outbox.payment.paid',
    ]);
  });

  it('books the shipment only AFTER the transaction commits', async () => {
    const h = build();
    await h.svc.settle(PAYMENT_ID, gatewayActor);
    expect(h.shipments.createForOrderSafe).toHaveBeenCalledTimes(1);
    expect(h.shipments.createForOrderSafe).toHaveBeenCalledWith('ord-1');
  });

  it('order transition failure rolls EVERYTHING back — no partial state', async () => {
    const h = build({ orderFlipThrows: new Error('lock wait timeout') });
    await expect(h.svc.settle(PAYMENT_ID, gatewayActor)).rejects.toThrow('lock wait timeout');

    expect(h.committed).toEqual([]); // payment never became PAID
    expect(h.tx.outboxEvent.create).not.toHaveBeenCalled(); // no payment.paid
    expect(h.shipments.createForOrderSafe).not.toHaveBeenCalled(); // no shipment
  });

  it('inventory commit failure rolls payment, order and outbox back', async () => {
    const h = build({ inventoryThrows: new Error('reservation vanished') });
    await expect(h.svc.settle(PAYMENT_ID, gatewayActor)).rejects.toThrow('reservation vanished');

    expect(h.committed).toEqual([]);
    expect(h.tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(h.shipments.createForOrderSafe).not.toHaveBeenCalled();
  });

  it('outbox failure rolls the business state back — state never exists without its event', async () => {
    const h = build({ outboxThrows: new Error('outbox insert failed') });
    await expect(h.svc.settle(PAYMENT_ID, gatewayActor)).rejects.toThrow('outbox insert failed');
    expect(h.committed).toEqual([]);
  });

  it('a CANCELLED order aborts before anything commits', async () => {
    const h = build({ orderStatus: 'CANCELLED' });
    await expect(h.svc.settle(PAYMENT_ID, gatewayActor)).rejects.toThrow(ConflictException);

    expect(h.committed).toEqual([]);
    expect(h.inventory.commitForOrder).not.toHaveBeenCalled(); // no inventory recreated
    expect(h.tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(h.shipments.createForOrderSafe).not.toHaveBeenCalled();
  });

  it('an already-PAID payment is a pure no-op — no transaction at all', async () => {
    const h = build({ paymentStatus: PaymentStatus.PAID });
    const out = await h.svc.settle(PAYMENT_ID, gatewayActor);

    expect(out.result).toBe('ALREADY_PAID');
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.shipments.createForOrderSafe).not.toHaveBeenCalled(); // no second shipment
  });

  it.each([PaymentStatus.EXPIRED, PaymentStatus.FAILED, PaymentStatus.REFUNDED])(
    'refuses to resurrect a terminal %s payment',
    async (status) => {
      const h = build({ paymentStatus: status });
      await expect(h.svc.settle(PAYMENT_ID, gatewayActor)).rejects.toThrow(ConflictException);
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('the gateway ledger update rides INSIDE the settlement transaction', async () => {
    const h = build();
    await h.svc.settle(PAYMENT_ID, gatewayActor);

    expect(h.tx.paymentGatewayTransaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: GTX_ID },
      data: expect.objectContaining({
        status: GatewayTransactionStatus.SETTLEMENT,
        providerStatus: 'settlement',
        providerTransactionId: 'trx-authoritative',
      }),
    }));
  });

  it('admin and gateway produce the SAME payment.paid event, differing only in source', async () => {
    const adminRun = build();
    await adminRun.svc.settle(PAYMENT_ID, { kind: 'ADMIN', adminId: 'admin-1', note: null });
    const adminEvent = adminRun.tx.outboxEvent.create.mock.calls[0][0].data;

    const gatewayRun = build();
    await gatewayRun.svc.settle(PAYMENT_ID, gatewayActor);
    const gatewayEvent = gatewayRun.tx.outboxEvent.create.mock.calls[0][0].data;

    expect(gatewayEvent.eventName).toBe(adminEvent.eventName); // payment.paid
    expect(gatewayEvent.routingKey).toBe(adminEvent.routingKey);
    expect(gatewayEvent.exchange).toBe(adminEvent.exchange);
    expect(Object.keys(JSON.parse(JSON.stringify(gatewayEvent.payload))).sort())
      .toEqual(Object.keys(JSON.parse(JSON.stringify(adminEvent.payload))).sort());
  });

  it('records the gateway as the settler in the audit trail, with no admin identity', async () => {
    const h = build();
    await h.svc.settle(PAYMENT_ID, gatewayActor);
    const after = h.tx.auditLog.create.mock.calls[0][0].data.after;

    expect(after).toMatchObject({ settledBy: 'gateway', provider: 'midtrans', providerStatus: 'settlement', status: 'PAID' });
    expect(after.verifiedByAdminId).toBeUndefined();
  });
});
