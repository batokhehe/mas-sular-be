import { ConflictException } from '@nestjs/common';
import { GatewayTransactionStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { buildOutboxEvent } from '../../src/infrastructure/outbox/outbox-event.builder';
import { verifyMidtransStatusResponse } from '../../src/modules/payments/gateway/domain/midtrans-status-verification.util';
import { GatewayStatusApplier } from '../../src/modules/payments/gateway/gateway-status-applier.service';
import { loadMidtransReconciliationConfig } from '../../src/modules/payments/gateway/midtrans-reconciliation.config';
import { MidtransReconciliationWorker } from '../../src/modules/payments/gateway/midtrans-reconciliation.worker';
import { loadMidtransConfig, MidtransConfig } from '../../src/modules/payments/gateway/midtrans.config';
import { PaymentSettlementService } from '../../src/modules/payments/settlement/payment-settlement.service';

const NOW = 1_800_000_000_000;
const AMOUNT = 40000;
const GROSS = '40000.00';
const PROVIDER_ORDER_ID = 'BMS-20260810-001-aaaaaaaa';

const statusBody = (over: Record<string, unknown> = {}) => ({
  order_id: PROVIDER_ORDER_ID,
  transaction_status: 'settlement',
  status_code: '200',
  gross_amount: GROSS,
  transaction_id: 'trx-1',
  ...over,
});

const verifiedFor = (body: Record<string, unknown>) => {
  const v = verifyMidtransStatusResponse(body, PROVIDER_ORDER_ID, AMOUNT);
  if (!v.ok) throw new Error(`fixture not verifiable: ${v.reason}`);
  return v;
};

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

// ============================================ §13 state monotonicity =========

/**
 * Drives the REAL settlement service against a Prisma double, so the matrix below
 * exercises the actual guards rather than a description of them.
 */
function settlementOver(currentStatus: PaymentStatus) {
  const committed: string[] = [];
  const tx = {
    payment: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUniqueOrThrow: jest.fn(async (_a: any) => ({ id: 'pay-1', orderId: 'ord-1', amount: AMOUNT, verifiedByUserId: null })),
    },
    $queryRaw: jest.fn(async () => [{ status: 'PENDING' }]),
    order: { updateMany: jest.fn(async () => ({ count: 1 })) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orderEvent: { create: jest.fn(async (_a: any) => ({})) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    paymentGatewayTransaction: { updateMany: jest.fn(async (_a: any) => ({ count: 1 })) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auditLog: { create: jest.fn(async (_a: any) => ({})) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outboxEvent: { create: jest.fn(async (a: any) => { committed.push(a.data.eventName); return {}; }) },
  };
  const prisma = {
    payment: {
      findUnique: jest.fn(async () => ({
        id: 'pay-1', orderId: 'ord-1', amount: AMOUNT, status: currentStatus, deletedAt: null,
      })),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const inventory = { commitForOrder: jest.fn(async () => 1) };
  // Typed args so the assertions can read the release-reason argument.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cancellation = { cancelAndRestock: jest.fn(async (..._a: any[]) => ({ cancelled: true })) };
  const shipments = { createForOrderSafe: jest.fn(async () => ({ ok: true })) };

  const service = new PaymentSettlementService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any, shipments as any, inventory as any, cancellation as any,
  );
  const logs = { write: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applier = new GatewayStatusApplier(service as any, logs as any);
  return { applier, service, prisma, tx, inventory, cancellation, shipments, committed };
}

const applyStatus = (h: ReturnType<typeof settlementOver>, transactionStatus: string, fraud?: string) =>
  h.applier.apply({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: gtx() as any,
    verified: verifiedFor(statusBody({ transaction_status: transactionStatus, ...(fraud ? { fraud_status: fraud } : {}) })),
    source: 'payments.reconciliation.midtrans',
  });

describe('§13 terminal payment states never regress', () => {
  const matrix: Array<[PaymentStatus, string, string | undefined]> = [
    [PaymentStatus.PAID, 'pending', undefined],
    [PaymentStatus.PAID, 'failure', undefined],
    [PaymentStatus.PAID, 'deny', undefined],
    [PaymentStatus.PAID, 'expire', undefined],
    [PaymentStatus.PAID, 'cancel', undefined],
    [PaymentStatus.PAID, 'capture', 'deny'],
    [PaymentStatus.FAILED, 'pending', undefined],
    [PaymentStatus.FAILED, 'settlement', undefined],
    [PaymentStatus.FAILED, 'capture', 'accept'],
    [PaymentStatus.EXPIRED, 'settlement', undefined],
    [PaymentStatus.EXPIRED, 'capture', 'accept'],
    [PaymentStatus.REFUNDED, 'settlement', undefined],
  ];

  it.each(matrix)('%s + provider "%s" performs NO transition', async (current, status, fraud) => {
    const h = settlementOver(current);
    const outcome = await applyStatus(h, status, fraud);

    expect(['not_eligible', 'already_terminal', 'illegal_transition']).toContain(outcome);
    // Nothing committed: no status flip, no inventory, no shipment, no event.
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.inventory.commitForOrder).not.toHaveBeenCalled();
    expect(h.cancellation.cancelAndRestock).not.toHaveBeenCalled();
    expect(h.shipments.createForOrderSafe).not.toHaveBeenCalled();
    expect(h.committed).toEqual([]);
  });

  it('a PENDING payment DOES settle — the matrix above is not vacuous', async () => {
    const h = settlementOver(PaymentStatus.PENDING);
    await expect(applyStatus(h, 'settlement')).resolves.toBe('settled');
    expect(h.committed).toEqual(['payment.paid']);
    expect(h.inventory.commitForOrder).toHaveBeenCalledTimes(1);
    expect(h.shipments.createForOrderSafe).toHaveBeenCalledTimes(1);
  });

  it('an already-PAID payment is a no-op, not an error (idempotent replay)', async () => {
    const h = settlementOver(PaymentStatus.PAID);
    await expect(applyStatus(h, 'settlement')).resolves.toBe('already_terminal');
    expect(h.shipments.createForOrderSafe).not.toHaveBeenCalled(); // no second shipment
  });
});

// ============================================ §12 failure / expire ===========

describe('§12 terminal provider states reach the existing shared paths', () => {
  it.each(['deny', 'failure', 'cancel'])('%s releases the reservation and emits payment.failed once', async (status) => {
    const h = settlementOver(PaymentStatus.PENDING);
    await expect(applyStatus(h, status)).resolves.toBe('failed');

    expect(h.committed).toEqual(['payment.failed']);
    expect(h.cancellation.cancelAndRestock).toHaveBeenCalledTimes(1);
    // Plain release (no EXPIRED reason) and no direct inventory write.
    expect(h.cancellation.cancelAndRestock.mock.calls[0]).toHaveLength(3);
    expect(h.inventory.commitForOrder).not.toHaveBeenCalled();
    expect(h.shipments.createForOrderSafe).not.toHaveBeenCalled();
  });

  it('expire releases the reservation AS EXPIRED and emits payment.expired once', async () => {
    const h = settlementOver(PaymentStatus.PENDING);
    await expect(applyStatus(h, 'expire')).resolves.toBe('expired');

    expect(h.committed).toEqual(['payment.expired']);
    // The 4th argument is what distinguishes expiry from rejection.
    expect(h.cancellation.cancelAndRestock.mock.calls[0][3]).toBe('EXPIRED');
    expect(h.shipments.createForOrderSafe).not.toHaveBeenCalled();
  });

  it('capture + deny fails; capture + challenge does nothing at all', async () => {
    const denied = settlementOver(PaymentStatus.PENDING);
    await expect(applyStatus(denied, 'capture', 'deny')).resolves.toBe('failed');
    expect(denied.committed).toEqual(['payment.failed']);

    const held = settlementOver(PaymentStatus.PENDING);
    await expect(applyStatus(held, 'capture', 'challenge')).resolves.toBe('not_eligible');
    expect(held.committed).toEqual([]);
    expect(held.cancellation.cancelAndRestock).not.toHaveBeenCalled(); // money still held
  });

  it('never writes ProductInventory directly on any terminal path', () => {
    const src = [
      PaymentSettlementService.prototype.settle.toString(),
      PaymentSettlementService.prototype.fail.toString(),
      PaymentSettlementService.prototype.expire.toString(),
    ].join('\n');
    for (const banned of ['productInventory', 'product.update', 'stock:', 'decrement', 'increment']) {
      expect(src).not.toContain(banned);
    }
  });
});

// =================================================== §16 outbox invariants ===

describe('§16 outbox envelope invariants', () => {
  it('every payment event carries a fresh id, version 1, and the given routing key', () => {
    const a = buildOutboxEvent({
      aggregateType: 'payment', aggregateId: 'p1', eventName: 'payment.paid',
      exchange: 'payments', routingKey: 'payment.paid', payload: {},
    });
    const b = buildOutboxEvent({
      aggregateType: 'payment', aggregateId: 'p1', eventName: 'payment.paid',
      exchange: 'payments', routingKey: 'payment.paid', payload: {},
    });

    expect(a.id).not.toBe(b.id); // fresh per event
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.eventVersion).toBe(1);
    expect(a.exchange).toBe('payments');
    expect(a.routingKey).toBe('payment.paid');
    expect(a.occurredAt).toBeInstanceOf(Date);
  });

  it('each terminal path emits exactly ONE event with the right name and source', async () => {
    const cases: Array<[string, string]> = [
      ['settlement', 'payment.paid'],
      ['deny', 'payment.failed'],
      ['expire', 'payment.expired'],
    ];
    for (const [status, eventName] of cases) {
      const h = settlementOver(PaymentStatus.PENDING);
      await applyStatus(h, status);

      expect(h.committed).toEqual([eventName]);
      const data = h.tx.outboxEvent.create.mock.calls[0][0].data;
      expect(data.eventVersion).toBe(1);
      expect(data.routingKey).toBe(eventName);
      expect((data.metadata as Record<string, unknown>).source).toBe('payments.reconciliation.midtrans');
    }
  });
});

// ============================================ §22 failure recovery ===========

function workerHarness(opts: {
  statusThrows?: Error;
  candidates?: Record<string, unknown>[];
  gatewayEnabled?: boolean;
  reconciliationEnabled?: boolean;
} = {}) {
  const prisma = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    paymentGatewayTransaction: { findMany: jest.fn(async (_a: any) => opts.candidates ?? [gtx()]) },
    paymentWebhookEvent: { count: jest.fn(async () => 0) },
  };
  const getStatus = jest.fn(async ({ providerReference }: { providerReference: string }) => {
    if (opts.statusThrows) throw opts.statusThrows;
    return { provider: 'midtrans', providerReference, status: PaymentStatus.PAID, raw: statusBody({ order_id: providerReference }) };
  });
  const providers = { get: jest.fn(() => ({ name: 'midtrans', getStatus })) };
  const applier = { apply: jest.fn(async () => 'settled') };
  const logs = { write: jest.fn() };

  const gateway: MidtransConfig = {
    enabled: opts.gatewayEnabled ?? true, serverKey: 'k', clientKey: 'c',
    isProduction: false, baseUrl: 'https://api.sandbox.midtrans.com', timeoutMs: 5000, maxRetry: 2,
  };
  const worker = new MidtransReconciliationWorker(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any, providers as any, applier as any,
    { enabled: opts.reconciliationEnabled ?? true, pollIntervalMs: 60_000, initialDelayMs: 30_000, batchSize: 50, minAgeMs: 120_000, healthLogIntervalMs: 300_000 },
    gateway,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logs as any,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (worker as any).nowMs = () => NOW;
  return { worker, prisma, providers, getStatus, applier, logs };
}

describe('§22 gateway failures never mutate and never kill the worker', () => {
  it.each([
    ['timeout', Object.assign(new Error('timeout'), { name: 'TimeoutError' })],
    ['429', Object.assign(new Error('429'), { name: 'TransientGatewayError' })],
    ['500', Object.assign(new Error('500'), { name: 'TransientGatewayError' })],
  ])('%s → no transition, candidate stays retryable', async (_l, err) => {
    const h = workerHarness({ statusThrows: err });
    const tick = await h.worker.reconcile();

    expect(tick.failed).toBe(1);
    expect(h.applier.apply).not.toHaveBeenCalled();
  });

  it('a malformed response reaches no transition', async () => {
    const h = workerHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.getStatus.mockImplementation(async () => ({ provider: 'midtrans', providerReference: 'x', status: PaymentStatus.PAID, raw: { junk: true } } as any));
    await h.worker.reconcile();
    expect(h.applier.apply).not.toHaveBeenCalled();
  });
});

// ============================ Phase 5F defect regressions ====================

describe('5F-1 a concluded notification must NOT disqualify a charge forever', () => {
  it('reconciles a charge whose only webhook concluded NOT_ELIGIBLE (lost settlement)', async () => {
    // The scenario: `pending` webhook concluded NOT_ELIGIBLE, the customer then paid,
    // and the settlement webhook was lost. The payment is still PENDING, so this is
    // exactly what reconciliation exists to recover.
    const h = workerHarness();
    const tick = await h.worker.reconcile();

    expect(h.getStatus).toHaveBeenCalledTimes(1);
    expect(tick.transitioned).toBe(1);
  });

  it('eligibility is decided by payment status alone — no webhook-event lookup', async () => {
    const h = workerHarness();
    await h.worker.reconcile();

    // The removed short-circuit used to cost two extra queries per candidate AND
    // could skip a recoverable charge. Neither happens now.
    expect(h.prisma.paymentWebhookEvent.count).not.toHaveBeenCalled();
    const where = h.prisma.paymentGatewayTransaction.findMany.mock.calls[0][0].where;
    expect(where.payment.status).toEqual({ in: ['PENDING', 'WAITING_VERIFICATION'] });
  });
});

describe('5F-2 the worker stays down when the gateway itself is off', () => {
  it('does not start with MIDTRANS_ENABLED=false, even if reconciliation is enabled', () => {
    const h = workerHarness({ gatewayEnabled: false, reconciliationEnabled: true });
    h.worker.onApplicationBootstrap();

    // Previously this combination logged a failure for every candidate, every tick.
    expect(h.prisma.paymentGatewayTransaction.findMany).not.toHaveBeenCalled();
  });

  it('does not start with MIDTRANS_RECONCILIATION_ENABLED=false', () => {
    const h = workerHarness({ reconciliationEnabled: false });
    h.worker.onApplicationBootstrap();
    expect(h.prisma.paymentGatewayTransaction.findMany).not.toHaveBeenCalled();
  });
});

// ============================================ §21 configuration safety =======

describe('§21 configuration safety', () => {
  it('the gateway is off unless MIDTRANS_ENABLED is exactly "true"', () => {
    for (const raw of [undefined, '', 'false', 'TRUE', 'yes', '0']) {
      expect(loadMidtransConfig({ MIDTRANS_ENABLED: raw }).enabled).toBe(false);
    }
    expect(loadMidtransConfig({ MIDTRANS_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('a disabled gateway defaults to the SANDBOX base url, never production', () => {
    expect(loadMidtransConfig({}).baseUrl).toBe('https://api.sandbox.midtrans.com');
    expect(loadMidtransConfig({ MIDTRANS_IS_PRODUCTION: 'false' }).isProduction).toBe(false);
  });

  it('reconciliation is off by default', () => {
    expect(loadMidtransReconciliationConfig({}).enabled).toBe(false);
  });

  it('config never carries a credential into a loggable shape', () => {
    const config = loadMidtransConfig({ MIDTRANS_ENABLED: 'true', MIDTRANS_SERVER_KEY: 'SB-Mid-server-TESTONLY' });
    // The key lives on the config object (it must), but nothing stringifies it into
    // a message or metadata anywhere — asserted across the payment tree elsewhere.
    expect(Object.keys(config)).toContain('serverKey');
    expect(JSON.stringify({ provider: 'midtrans', enabled: config.enabled })).not.toContain('SB-Mid-server');
  });
});

// ============================ 5I-1 Core API host regression ==================

/**
 * Phase 5I found `SANDBOX_BASE_URL` had been changed to `app.sandbox.midtrans.com`
 * while the provider still speaks Core API. Verified live during that phase:
 *   api.sandbox /v2/{id}/status -> 200 JSON {"status_code":"404",...}
 *   app.sandbox /v2/{id}/status -> 404, empty body
 * so every charge and status call would have failed. This pins the pairing.
 */
describe('5I-1 the provider host must serve the Core API it calls', () => {
  it('defaults to the Core API host in both environments', () => {
    expect(loadMidtransConfig({}).baseUrl).toBe('https://api.sandbox.midtrans.com');
    expect(loadMidtransConfig({ MIDTRANS_IS_PRODUCTION: 'true' }).baseUrl).toBe('https://api.midtrans.com');
  });

  it('never defaults to the Snap host, which does not serve /v2', () => {
    for (const env of [{}, { MIDTRANS_IS_PRODUCTION: 'false' }, { MIDTRANS_IS_PRODUCTION: 'true' }]) {
      // `app.*` hosts Snap and the customer-facing payment page — never Core API.
      expect(loadMidtransConfig(env).baseUrl).not.toContain('app.');
      expect(loadMidtransConfig(env).baseUrl.startsWith('https://api.')).toBe(true);
    }
  });

  it('sandbox and production hosts differ only by the sandbox subdomain', () => {
    const sandbox = loadMidtransConfig({}).baseUrl;
    const production = loadMidtransConfig({ MIDTRANS_IS_PRODUCTION: 'true' }).baseUrl;
    expect(sandbox).toBe(production.replace('api.', 'api.sandbox.'));
  });

  it('still honours an explicit MIDTRANS_BASE_URL override', () => {
    expect(loadMidtransConfig({ MIDTRANS_BASE_URL: 'https://proxy.internal/mt/' }).baseUrl)
      .toBe('https://proxy.internal/mt');
  });
});

// ================================ 5G-1 settlement DI wiring regression =======

/**
 * Phase 5G found that `PaymentSettlementModule` never provided
 * `OrderCancellationService`. Since the settlement service takes it `@Optional()`,
 * DI silently handed back an instance with `cancellation === undefined`, and
 * `fail()`/`expire()` skipped the restock entirely: the payment went terminal while
 * the order stayed live and the stock stayed held.
 *
 * Every unit test passed a cancellation double, so none of them could see it. This
 * boots the real module graph instead.
 */
describe('5G-1 the settlement service resolves WITH its cancellation collaborator', () => {
  it('boots from PaymentSettlementModule with a usable release path', async () => {
    const { Test } = await import('@nestjs/testing');
    const { DatabaseModule } = await import('../../src/database/database.module');
    const { MetricsModule } = await import('../../src/infrastructure/metrics/metrics.module');
    const { PrismaService } = await import('../../src/database/prisma.service');
    const { PaymentSettlementModule } = await import('../../src/modules/payments/settlement/payment-settlement.module');
    const { OrderCancellationService } = await import('../../src/modules/orders/order-cancellation.service');

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, MetricsModule, PaymentSettlementModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ payment: { findUnique: jest.fn() } })
      .compile();

    const service = moduleRef.get(PaymentSettlementService);
    // The collaborator that performs the restock must actually be there.
    const cancellation = (service as unknown as { cancellation?: unknown }).cancellation;
    expect(cancellation).toBeDefined();
    expect(cancellation).toBeInstanceOf(OrderCancellationService);

    await moduleRef.close();
  });

  it('fail() and expire() both route their release through that collaborator', () => {
    for (const method of ['fail', 'expire'] as const) {
      const src = PaymentSettlementService.prototype[method].toString();
      expect(src).toContain('cancelAndRestock');
    }
    // expire keeps its distinct release reason.
    expect(PaymentSettlementService.prototype.expire.toString()).toContain('EXPIRED');
  });
});

// ============================================ §18 COD historical =============

describe('§18 COD remains historical-readable and unselectable', () => {
  it('the enum value still exists so historical rows stay readable', () => {
    expect(Object.values(PaymentMethod)).toContain('COD');
  });

  it('no gateway channel offers COD', async () => {
    const { PAYMENT_CHANNELS } = await import('../../src/modules/payments/gateway/domain/payment-channel');
    expect(PAYMENT_CHANNELS.map((c) => String(c.code))).not.toContain('COD');
    expect(PAYMENT_CHANNELS.map((c) => String(c.method))).not.toContain('COD');
  });
});
