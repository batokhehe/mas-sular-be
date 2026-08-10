import { ConflictException } from '@nestjs/common';
import { GatewayTransactionStatus, PaymentStatus } from '@prisma/client';
import { verifyMidtransStatusResponse } from '../../src/modules/payments/gateway/domain/midtrans-status-verification.util';
import { GatewayStatusApplier } from '../../src/modules/payments/gateway/gateway-status-applier.service';
import {
  loadMidtransReconciliationConfig,
  MidtransReconciliationConfig,
} from '../../src/modules/payments/gateway/midtrans-reconciliation.config';
import { MidtransReconciliationWorker } from '../../src/modules/payments/gateway/midtrans-reconciliation.worker';

const NOW = 1_800_000_000_000;
const AMOUNT = 40000;
const GROSS = '40000.00';
const ORDER_NUMBER = 'BMS-20260810-001';
const PROVIDER_ORDER_ID = `${ORDER_NUMBER}-aaaaaaaa`; // Phase 5A shape

function cfg(over: Partial<MidtransReconciliationConfig> = {}): MidtransReconciliationConfig {
  return {
    enabled: true,
    pollIntervalMs: 60_000,
    initialDelayMs: 30_000,
    batchSize: 50,
    minAgeMs: 120_000,
    healthLogIntervalMs: 300_000,
    ...over,
  };
}

const gtx = (over: Record<string, unknown> = {}) => ({
  id: 'gtx-1',
  paymentId: 'pay-1',
  provider: 'midtrans',
  providerOrderId: PROVIDER_ORDER_ID,
  providerTransactionId: null,
  grossAmount: AMOUNT,
  status: GatewayTransactionStatus.PENDING,
  createdAt: new Date(NOW - 10 * 60_000),
  ...over,
});

const statusBody = (over: Record<string, unknown> = {}) => ({
  order_id: PROVIDER_ORDER_ID,
  transaction_status: 'settlement',
  status_code: '200',
  gross_amount: GROSS,
  transaction_id: 'trx-authoritative',
  ...over,
});

const verifiedFor = (body: Record<string, unknown>) => {
  const v = verifyMidtransStatusResponse(body, PROVIDER_ORDER_ID, AMOUNT);
  if (!v.ok) throw new Error(`fixture is not verifiable: ${v.reason}`);
  return v;
};

// ================================================== the shared applier =======

interface ApplierOpts {
  settleThrows?: Error;
  failThrows?: Error;
  expireThrows?: Error;
  settleResult?: 'SETTLED' | 'ALREADY_PAID';
  terminalResult?: 'APPLIED' | 'ALREADY_TERMINAL';
}

function applierHarness(opts: ApplierOpts = {}) {
  const payment = { id: 'pay-1', orderId: 'ord-1' };
  const settlement = {
    settle: jest.fn(async () => {
      if (opts.settleThrows) throw opts.settleThrows;
      return { result: opts.settleResult ?? 'SETTLED', payment };
    }),
    fail: jest.fn(async () => {
      if (opts.failThrows) throw opts.failThrows;
      return { result: opts.terminalResult ?? 'APPLIED', payment };
    }),
    expire: jest.fn(async () => {
      if (opts.expireThrows) throw opts.expireThrows;
      return { result: opts.terminalResult ?? 'APPLIED', payment };
    }),
  };
  const logs = { write: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applier = new GatewayStatusApplier(settlement as any, logs as any);
  return { applier, settlement, logs };
}

const apply = (h: ReturnType<typeof applierHarness>, body: Record<string, unknown>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h.applier.apply({ transaction: gtx() as any, verified: verifiedFor(body), source: 'payments.reconciliation.midtrans' });

describe('GatewayStatusApplier — terminal state mapping (§4)', () => {
  it('settlement → the existing PAID path', async () => {
    const h = applierHarness();
    await expect(apply(h, statusBody({ transaction_status: 'settlement' }))).resolves.toBe('settled');
    expect(h.settlement.settle).toHaveBeenCalledTimes(1);
    expect(h.settlement.fail).not.toHaveBeenCalled();
    expect(h.settlement.expire).not.toHaveBeenCalled();
  });

  it('capture + fraud accept → PAID', async () => {
    const h = applierHarness();
    await expect(apply(h, statusBody({ transaction_status: 'capture', fraud_status: 'accept' }))).resolves.toBe('settled');
    expect(h.settlement.settle).toHaveBeenCalledTimes(1);
  });

  it('capture + challenge → NOT paid, and no terminal transition either', async () => {
    const h = applierHarness();
    await expect(apply(h, statusBody({ transaction_status: 'capture', fraud_status: 'challenge' }))).resolves.toBe('not_eligible');
    expect(h.settlement.settle).not.toHaveBeenCalled();
    expect(h.settlement.fail).not.toHaveBeenCalled();
  });

  it('capture + deny → the existing FAILED path', async () => {
    const h = applierHarness();
    await expect(apply(h, statusBody({ transaction_status: 'capture', fraud_status: 'deny' }))).resolves.toBe('failed');
    expect(h.settlement.fail).toHaveBeenCalledTimes(1);
    expect(h.settlement.settle).not.toHaveBeenCalled();
  });

  it.each(['deny', 'failure', 'cancel'])('%s → the existing FAILED path', async (status) => {
    const h = applierHarness();
    await expect(apply(h, statusBody({ transaction_status: status }))).resolves.toBe('failed');
    // `cancel` lands here because the EXISTING mapper already decided a cancelled
    // charge is a terminal non-payment and FAILED is the vocabulary we have.
    expect(h.settlement.fail).toHaveBeenCalledTimes(1);
  });

  it('expire → the existing EXPIRED path, not the FAILED one', async () => {
    const h = applierHarness();
    await expect(apply(h, statusBody({ transaction_status: 'expire' }))).resolves.toBe('expired');
    expect(h.settlement.expire).toHaveBeenCalledTimes(1);
    // The distinction matters: expiry releases reservations as EXPIRED.
    expect(h.settlement.fail).not.toHaveBeenCalled();
  });

  it('pending → unchanged', async () => {
    const h = applierHarness();
    await expect(apply(h, statusBody({ transaction_status: 'pending', status_code: '201' }))).resolves.toBe('not_eligible');
    expect(h.settlement.settle).not.toHaveBeenCalled();
    expect(h.settlement.fail).not.toHaveBeenCalled();
    expect(h.settlement.expire).not.toHaveBeenCalled();
  });

  it('refund is inert — reversal policy is out of scope, not guessed', async () => {
    const h = applierHarness();
    await expect(apply(h, statusBody({ transaction_status: 'refund' }))).resolves.toBe('not_eligible');
    expect(h.settlement.fail).not.toHaveBeenCalled();
  });

  it('an already-terminal payment reports already_terminal, running no side effects', async () => {
    const paid = applierHarness({ settleResult: 'ALREADY_PAID' });
    await expect(apply(paid, statusBody())).resolves.toBe('already_terminal');

    const failed = applierHarness({ terminalResult: 'ALREADY_TERMINAL' });
    await expect(apply(failed, statusBody({ transaction_status: 'deny' }))).resolves.toBe('already_terminal');
  });

  it('a legal-transition refusal is a conclusion, not a throw', async () => {
    const h = applierHarness({ settleThrows: new ConflictException('Order is cancelled') });
    await expect(apply(h, statusBody())).resolves.toBe('illegal_transition');
  });

  it('a rolled-back transaction propagates so the caller can retry', async () => {
    const h = applierHarness({ settleThrows: new Error('deadlock detected') });
    await expect(apply(h, statusBody())).rejects.toThrow('deadlock');
  });

  it('passes the authoritative status and gateway status to the transition', async () => {
    const h = applierHarness();
    await apply(h, statusBody({ transaction_status: 'settlement', transaction_id: 'auth-id' }));

    expect(h.settlement.settle).toHaveBeenCalledWith('pay-1', expect.objectContaining({
      kind: 'GATEWAY',
      providerStatus: 'settlement',
      providerTransactionId: 'auth-id',
      gatewayStatus: GatewayTransactionStatus.SETTLEMENT,
      source: 'payments.reconciliation.midtrans',
    }));
  });

  it('logs only safe correlators', async () => {
    const h = applierHarness();
    await apply(h, statusBody());
    const entry = h.logs.write.mock.calls[0][0];

    expect(Object.keys(entry.metadata).sort()).toEqual(
      ['provider', 'providerOrderId', 'providerStatus', 'providerTransactionId', 'reason', 'result', 'source'].sort(),
    );
    expect(JSON.stringify(h.logs.write.mock.calls)).not.toContain('Mid-server');
  });
});

// =================================================== reconciliation worker ==

interface WorkerOpts {
  candidates?: Record<string, unknown>[];
  statusThrows?: Error;
  statusBodyFor?: (t: Record<string, unknown>) => Record<string, unknown>;
  applyOutcome?: string;
  applyThrows?: Error;
  webhookEventCounts?: { open: number; any: number };
  config?: Partial<MidtransReconciliationConfig>;
}

function workerHarness(opts: WorkerOpts = {}) {
  const candidates = opts.candidates ?? [gtx()];
  const counts = opts.webhookEventCounts ?? { open: 0, any: 0 };
  let countCall = 0;

  const prisma = {
    // Typed arg so `.mock.calls[0][0]` is reachable from the assertions below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    paymentGatewayTransaction: { findMany: jest.fn(async (_args: any) => candidates) },
    paymentWebhookEvent: {
      count: jest.fn(async () => (countCall++ % 2 === 0 ? counts.open : counts.any)),
    },
  };

  const getStatus = jest.fn(async ({ providerReference }: { providerReference: string }) => {
    if (opts.statusThrows) throw opts.statusThrows;
    const body = opts.statusBodyFor
      ? opts.statusBodyFor({ providerReference })
      : statusBody({ order_id: providerReference });
    return { provider: 'midtrans', providerReference, status: PaymentStatus.PAID, raw: body };
  });
  const providers = { get: jest.fn(() => ({ name: 'midtrans', getStatus })) };

  const applier = {
    apply: jest.fn(async () => {
      if (opts.applyThrows) throw opts.applyThrows;
      return opts.applyOutcome ?? 'settled';
    }),
  };
  const logs = { write: jest.fn() };

  const gateway = {
    enabled: true, serverKey: 'k', clientKey: 'c', isProduction: false,
    baseUrl: 'https://api.sandbox.midtrans.com', timeoutMs: 5000, maxRetry: 2,
  };
  const worker = new MidtransReconciliationWorker(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any, providers as any, applier as any, cfg(opts.config), gateway, logs as any,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (worker as any).nowMs = () => NOW;
  return { worker, prisma, providers, getStatus, applier, logs };
}

describe('MidtransReconciliationWorker — candidate selection', () => {
  it('selects only open Midtrans charges past the minimum age', async () => {
    const h = workerHarness();
    await h.worker.reconcile();

    const where = h.prisma.paymentGatewayTransaction.findMany.mock.calls[0][0].where;
    expect(where.provider).toBe('midtrans');            // never manual BANK_TRANSFER
    expect(where.providerOrderId).toEqual({ not: null });
    expect(where.status.notIn).toEqual(expect.arrayContaining(['SETTLEMENT', 'FAILED', 'EXPIRED', 'CANCELLED']));
    expect(where.payment.status).toEqual({ in: ['PENDING', 'WAITING_VERIFICATION'] });
    expect(where.createdAt).toEqual({ lte: new Date(NOW - 120_000) });
  });

  it('an already PAID/FAILED/EXPIRED payment is excluded by the query itself', async () => {
    const h = workerHarness();
    await h.worker.reconcile();
    const { status } = h.prisma.paymentGatewayTransaction.findMany.mock.calls[0][0].where.payment;
    // Terminal payments simply are not candidates — no wasted Status API call.
    expect(status.in).not.toContain('PAID');
    expect(status.in).not.toContain('FAILED');
    expect(status.in).not.toContain('EXPIRED');
  });

  it('respects the configured batch size', async () => {
    const h = workerHarness({ config: { batchSize: 7 } });
    await h.worker.reconcile();
    expect(h.prisma.paymentGatewayTransaction.findMany.mock.calls[0][0].take).toBe(7);
  });

  it('still reconciles a charge whose notifications all concluded (Phase 5F fix)', async () => {
    // A notification that concluded NOT_ELIGIBLE only means "not paid YET". If the
    // later settlement webhook is lost, this charge is precisely what reconciliation
    // must recover — so a concluded notification no longer disqualifies it. A
    // genuinely settled charge is excluded earlier, by the payment-status filter.
    const h = workerHarness({ webhookEventCounts: { open: 0, any: 3 } });
    const tick = await h.worker.reconcile();

    expect(h.getStatus).toHaveBeenCalledTimes(1);
    expect(tick.transitioned).toBe(1);
  });

  it('DOES reconcile a charge whose notification is still unresolved', async () => {
    const h = workerHarness({ webhookEventCounts: { open: 1, any: 1 } });
    const tick = await h.worker.reconcile();

    expect(h.getStatus).toHaveBeenCalledTimes(1); // RECEIVED / VERIFICATION_FAILED → retry
    expect(tick.transitioned).toBe(1);
  });
});

describe('MidtransReconciliationWorker — correlation (§7)', () => {
  it('calls the Status API with the EXACT stored providerOrderId', async () => {
    const h = workerHarness();
    await h.worker.reconcile();

    expect(h.getStatus).toHaveBeenCalledWith({ paymentId: 'pay-1', providerReference: PROVIDER_ORDER_ID });
  });

  it('never reconstructs the id from the order number', async () => {
    const h = workerHarness();
    await h.worker.reconcile();

    const used = h.getStatus.mock.calls[0][0].providerReference;
    expect(used).toBe(PROVIDER_ORDER_ID);
    expect(used).not.toBe(ORDER_NUMBER); // the bare order number is never the reference
    expect(h.getStatus).not.toHaveBeenCalledWith(expect.objectContaining({ providerReference: ORDER_NUMBER }));
  });

  it('uses the existing provider (one HTTP client, one retry policy)', async () => {
    const h = workerHarness();
    await h.worker.reconcile();
    expect(h.providers.get).toHaveBeenCalledWith('midtrans');
  });
});

describe('MidtransReconciliationWorker — Status API failures (§15)', () => {
  const failures: Array<[string, Error]> = [
    ['timeout', Object.assign(new Error('timeout'), { name: 'TimeoutError' })],
    ['429', Object.assign(new Error('429'), { name: 'TransientGatewayError' })],
    ['500', Object.assign(new Error('500'), { name: 'TransientGatewayError' })],
    ['502', Object.assign(new Error('502'), { name: 'TransientGatewayError' })],
    ['503', Object.assign(new Error('503'), { name: 'TransientGatewayError' })],
    ['504', Object.assign(new Error('504'), { name: 'TransientGatewayError' })],
    ['network error', Object.assign(new Error('ECONNRESET'), { name: 'FetchError' })],
  ];

  it.each(failures)('%s → no business mutation, counted as failed', async (_label, err) => {
    const h = workerHarness({ statusThrows: err });
    const tick = await h.worker.reconcile();

    expect(tick.failed).toBe(1);
    expect(tick.transitioned).toBe(0);
    expect(h.applier.apply).not.toHaveBeenCalled(); // nothing reaches the state machine
  });

  it('a malformed response mutates nothing and is not a hard failure', async () => {
    const h = workerHarness({ statusBodyFor: () => ({ nonsense: true }) });
    const tick = await h.worker.reconcile();

    expect(h.applier.apply).not.toHaveBeenCalled();
    expect(tick.transitioned).toBe(0);
  });

  it('a response for a DIFFERENT order never transitions anything', async () => {
    const h = workerHarness({ statusBodyFor: () => statusBody({ order_id: 'SOMEONE-ELSE' }) });
    await h.worker.reconcile();
    expect(h.applier.apply).not.toHaveBeenCalled();
  });

  it('an amount mismatch never transitions anything', async () => {
    const h = workerHarness({ statusBodyFor: () => statusBody({ gross_amount: '1.00' }) });
    await h.worker.reconcile();
    expect(h.applier.apply).not.toHaveBeenCalled();
  });

  it('an unknown providerOrderId creates NOTHING and moves on', async () => {
    // Midtrans answers 404-shaped: status_code 404 with no transaction_status.
    const h = workerHarness({ statusBodyFor: () => ({ status_code: '404', status_message: "Transaction doesn't exist." }) });
    const tick = await h.worker.reconcile();

    expect(h.applier.apply).not.toHaveBeenCalled();
    expect(tick.scanned).toBe(1);
  });

  it('never logs a raw response or an error message that could echo a header', async () => {
    const h = workerHarness({ statusThrows: Object.assign(new Error('Basic Mid-server-SECRET rejected'), { name: 'TransientGatewayError' }) });
    await h.worker.reconcile();

    const written = JSON.stringify(h.logs.write.mock.calls);
    expect(written).not.toContain('Mid-server');
    expect(written).not.toContain('Basic ');
    expect(written).toContain('TransientGatewayError'); // the CLASS is safe
  });
});

describe('MidtransReconciliationWorker — resilience and idempotency', () => {
  it('one failing candidate does not stop the sweep', async () => {
    const h = workerHarness({ candidates: [gtx({ id: 'a', paymentId: 'p-a' }), gtx({ id: 'b', paymentId: 'p-b' }), gtx({ id: 'c', paymentId: 'p-c' })] });
    h.getStatus
      .mockImplementationOnce(async () => { throw Object.assign(new Error('boom'), { name: 'TransientGatewayError' }); })
      .mockImplementation(async ({ providerReference }: { providerReference: string }) => ({
        provider: 'midtrans', providerReference, status: PaymentStatus.PAID, raw: statusBody({ order_id: providerReference }),
      }));

    const tick = await h.worker.reconcile();

    expect(tick.scanned).toBe(3);
    expect(tick.failed).toBe(1);
    expect(tick.transitioned).toBe(2); // the outage did not kill the worker
  });

  it('a rolled-back transition is counted as failed and left for the next tick', async () => {
    const h = workerHarness({ applyThrows: new Error('deadlock detected') });
    const tick = await h.worker.reconcile();

    expect(tick.failed).toBe(1);
    expect(tick.transitioned).toBe(0);
  });

  it('running twice over an already-settled charge transitions once', async () => {
    const first = workerHarness({ applyOutcome: 'settled' });
    expect((await first.worker.reconcile()).transitioned).toBe(1);

    // Second sweep: the payment is now PAID, so the CAS inside the shared transition
    // reports already_terminal — no second event, no second commit.
    const second = workerHarness({ applyOutcome: 'already_terminal' });
    const tick = await second.worker.reconcile();
    expect(tick.transitioned).toBe(0);
    expect(tick.unchanged).toBe(1);
  });

  it('an illegal transition (cancelled order) is not retried as a failure', async () => {
    const h = workerHarness({ applyOutcome: 'illegal_transition' });
    const tick = await h.worker.reconcile();

    expect(tick.failed).toBe(0);
    expect(tick.unchanged).toBe(1); // a conclusion, not an error
  });

  it('holds no lock, mutex or claim of its own', () => {
    const src = MidtransReconciliationWorker.prototype.reconcile.toString()
      + MidtransReconciliationWorker.prototype.reconcileOne.toString();
    for (const banned of ['lock', 'mutex', 'redis', 'claim', 'semaphore']) {
      expect(src.toLowerCase()).not.toContain(banned);
    }
  });
});

describe('MidtransReconciliationWorker — lifecycle', () => {
  it('does nothing at all when disabled', () => {
    const h = workerHarness({ config: { enabled: false } });
    h.worker.onApplicationBootstrap();

    expect(h.prisma.paymentGatewayTransaction.findMany).not.toHaveBeenCalled();
    expect(h.getStatus).not.toHaveBeenCalled();
  });

  it('is disabled by default, and its defaults follow the existing worker convention', () => {
    const defaults = loadMidtransReconciliationConfig({});
    expect(defaults.enabled).toBe(false);
    expect(defaults.pollIntervalMs).toBe(60_000);
    expect(defaults.batchSize).toBe(50);
    expect(defaults.minAgeMs).toBe(120_000); // mirrors SHIPMENT_RECONCILIATION_DELAY_MS
  });

  it('only enables on the exact string "true"', () => {
    for (const raw of ['false', '1', 'TRUE', 'yes', undefined]) {
      expect(loadMidtransReconciliationConfig({ MIDTRANS_RECONCILIATION_ENABLED: raw }).enabled).toBe(false);
    }
    expect(loadMidtransReconciliationConfig({ MIDTRANS_RECONCILIATION_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('shuts down without leaving a timer behind', async () => {
    const h = workerHarness({ config: { enabled: false } });
    h.worker.onApplicationBootstrap();
    await expect(h.worker.onModuleDestroy()).resolves.toBeUndefined();
  });
});
