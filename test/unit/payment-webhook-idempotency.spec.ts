import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { MidtransWebhookDto } from '../../src/modules/payments/gateway/application/dto/midtrans-webhook.dto';
import {
  MIDTRANS_FINGERPRINT_VERSION,
  midtransNotificationCanonical,
  midtransWebhookFingerprint,
  parseMidtransNotificationTime,
} from '../../src/modules/payments/gateway/domain/midtrans-webhook-fingerprint.util';
import { MidtransConfig } from '../../src/modules/payments/gateway/midtrans.config';
import { PaymentGatewayPersistenceService } from '../../src/modules/payments/gateway/payment-gateway-persistence.service';
import { buildWebhookSnapshot, PaymentWebhookService } from '../../src/modules/payments/gateway/payment-webhook.service';

const SERVER_KEY = 'SB-Mid-server-SECRET-KEY';
const ORDER_NUMBER = 'BMS-20260712-001';
const PROVIDER_ORDER_ID = `${ORDER_NUMBER}-aaaaaaaa`; // Phase 5A: {orderNumber}-{attemptId8}
const GROSS = '130000.00';
const GTX_ID = 'gtx-1';

const CONFIG: MidtransConfig = {
  enabled: true,
  serverKey: SERVER_KEY,
  clientKey: 'ck',
  isProduction: false,
  baseUrl: 'https://api.sandbox.midtrans.com',
  timeoutMs: 5000,
  maxRetry: 2,
};

const signatureOf = (orderId: string, statusCode: string, gross: string, key = SERVER_KEY) =>
  createHash('sha512').update(`${orderId}${statusCode}${gross}${key}`).digest('hex');

function notification(over: Partial<MidtransWebhookDto> = {}): MidtransWebhookDto {
  const order_id = (over.order_id ?? PROVIDER_ORDER_ID) as string;
  const status_code = (over.status_code ?? '200') as string;
  const gross_amount = (over.gross_amount ?? GROSS) as string;
  return {
    order_id,
    status_code,
    gross_amount,
    signature_key: signatureOf(order_id, status_code, gross_amount),
    transaction_id: 'a1b2c3',
    transaction_status: 'settlement',
    fraud_status: 'accept',
    payment_type: 'qris',
    transaction_time: '2026-08-08 10:00:00',
    settlement_time: '2026-08-08 10:05:00',
    merchant_id: 'M1',
    ...over,
  } as MidtransWebhookDto;
}

/** Ledger double. `null` transaction ⇒ the provider order id is unknown to us. */
function harness(opts: { transaction?: Record<string, unknown> | null; outcome?: string } = {}) {
  const logs = { write: jest.fn() };
  const ledger = {
    findByProviderOrderId: jest.fn().mockResolvedValue(
      opts.transaction === undefined
        ? { id: GTX_ID, paymentId: 'pay-1', providerTransactionId: null }
        : opts.transaction,
    ),
    recordWebhookNotification: jest.fn().mockResolvedValue(opts.outcome ?? 'applied'),
    // Phase 5D: terminal by default so these Phase 5C specs exercise the receipt
    // path only; settlement has its own spec.
    findWebhookEvent: jest.fn().mockResolvedValue({ settlementState: 'NOT_ELIGIBLE' }),
    markWebhookSettlementState: jest.fn().mockResolvedValue(undefined),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { svc: new PaymentWebhookService(CONFIG, ledger as any, logs as any), ledger, logs };
}

// =========================================================== fingerprint ====

describe('Midtrans webhook fingerprint', () => {
  const identity = {
    orderId: PROVIDER_ORDER_ID,
    transactionId: 'a1b2c3',
    statusCode: '200',
    transactionStatus: 'settlement',
    fraudStatus: 'accept',
    grossAmount: GROSS,
  };

  it('is deterministic — repeated identical notifications produce ONE fingerprint', () => {
    expect(midtransWebhookFingerprint(identity)).toBe(midtransWebhookFingerprint({ ...identity }));
    // Field order in the source object must not matter.
    const reordered = {
      grossAmount: GROSS, fraudStatus: 'accept', transactionStatus: 'settlement',
      statusCode: '200', transactionId: 'a1b2c3', orderId: PROVIDER_ORDER_ID,
    };
    expect(midtransWebhookFingerprint(reordered)).toBe(midtransWebhookFingerprint(identity));
  });

  it('treats an absent and an explicitly-null optional field as one identity', () => {
    const absent = { orderId: 'o', statusCode: '200', grossAmount: '1.00' };
    const nulled = { ...absent, transactionId: null, transactionStatus: null, fraudStatus: null };
    expect(midtransWebhookFingerprint(absent)).toBe(midtransWebhookFingerprint(nulled));
  });

  it.each([
    ['order id', { orderId: `${ORDER_NUMBER}-bbbbbbbb` }],
    ['transaction id', { transactionId: 'zzz' }],
    ['status code', { statusCode: '201' }],
    ['transaction status', { transactionStatus: 'pending' }],
    ['fraud status', { fraudStatus: 'challenge' }],
    ['gross amount', { grossAmount: '999.00' }],
  ])('a different %s is a DIFFERENT gateway state', (_label, patch) => {
    expect(midtransWebhookFingerprint({ ...identity, ...patch })).not.toBe(midtransWebhookFingerprint(identity));
  });

  it('separates capture from settlement — the case signature_key alone would LOSE', () => {
    // A card charge emits capture then settlement with the SAME status_code and the
    // same amount, so both notifications carry an identical signature_key.
    const capture = { ...identity, transactionStatus: 'capture' };
    const settlement = { ...identity, transactionStatus: 'settlement' };

    expect(signatureOf(PROVIDER_ORDER_ID, '200', GROSS)).toBe(signatureOf(PROVIDER_ORDER_ID, '200', GROSS));
    expect(midtransWebhookFingerprint(capture)).not.toBe(midtransWebhookFingerprint(settlement));
  });

  it('separates capture+challenge from capture+accept (fraud_status carries the state)', () => {
    const challenge = { ...identity, transactionStatus: 'capture', fraudStatus: 'challenge' };
    const accept = { ...identity, transactionStatus: 'capture', fraudStatus: 'accept' };
    expect(midtransWebhookFingerprint(challenge)).not.toBe(midtransWebhookFingerprint(accept));
  });

  it('is not delimiter-ambiguous — a colon inside a value cannot forge a collision', () => {
    // A naive `${orderId}:${transactionId}` join would make these two identical.
    const a = { ...identity, orderId: 'A:B', transactionId: 'C' };
    const b = { ...identity, orderId: 'A', transactionId: 'B:C' };
    expect(midtransWebhookFingerprint(a)).not.toBe(midtransWebhookFingerprint(b));
  });

  it('never embeds the signature key or the server key', () => {
    const canonical = midtransNotificationCanonical(identity);
    expect(canonical).not.toContain(SERVER_KEY);
    expect(canonical).not.toContain(signatureOf(PROVIDER_ORDER_ID, '200', GROSS));
    expect(canonical.startsWith(`midtrans:${MIDTRANS_FINGERPRINT_VERSION}:`)).toBe(true);
  });

  it('is a 64-char hex digest that fits the unique column', () => {
    expect(midtransWebhookFingerprint(identity)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ================================================= notification ordering ====

describe('parseMidtransNotificationTime', () => {
  it('prefers settlement_time so a stale pending compares strictly older', () => {
    const settled = parseMidtransNotificationTime({ transaction_time: '2026-08-08 10:00:00', settlement_time: '2026-08-08 10:05:00' });
    const pending = parseMidtransNotificationTime({ transaction_time: '2026-08-08 10:00:00' });
    expect(settled!.getTime()).toBeGreaterThan(pending!.getTime());
  });

  it('returns null for an unrecognised format — refusing to order, not mis-ordering', () => {
    for (const raw of ['08/08/2026 10:00', '2026-08-08T10:00:00Z', 'yesterday', '', '2026-08-08']) {
      expect(parseMidtransNotificationTime({ transaction_time: raw })).toBeNull();
    }
    expect(parseMidtransNotificationTime({})).toBeNull();
  });

  it('rejects an impossible date instead of silently rolling it over', () => {
    expect(parseMidtransNotificationTime({ transaction_time: '2026-13-01 10:00:00' })).toBeNull();
    expect(parseMidtransNotificationTime({ transaction_time: '2026-02-31 10:00:00' })).toBeNull();
  });
});

// ================================================== correlation & flow ======

describe('PaymentWebhookService — correlation', () => {
  it('correlates on provider + the EXACT provider order id', async () => {
    const { svc, ledger } = harness();
    await svc.handleMidtransNotification(notification());
    expect(ledger.findByProviderOrderId).toHaveBeenCalledWith('midtrans', PROVIDER_ORDER_ID);
  });

  it('never looks the transaction up by the bare application order number', async () => {
    const { svc, ledger } = harness();
    await svc.handleMidtransNotification(notification());
    expect(ledger.findByProviderOrderId).not.toHaveBeenCalledWith('midtrans', ORDER_NUMBER);
    // and the attempt suffix is carried through untouched, not reconstructed
    expect(ledger.findByProviderOrderId.mock.calls[0][1]).toBe(PROVIDER_ORDER_ID);
  });

  it('a bare order number does not correlate — it is safely acknowledged, not guessed', async () => {
    const { svc, ledger } = harness({ transaction: null });
    const result = await svc.handleMidtransNotification(notification({ order_id: ORDER_NUMBER }));

    expect(result).toEqual({ outcome: 'unknown_transaction', settlement: 'skipped' });
    expect(ledger.recordWebhookNotification).not.toHaveBeenCalled();
  });

  it('correlation happens only AFTER signature verification', async () => {
    const { svc, ledger } = harness();
    await svc.handleMidtransNotification(notification({ signature_key: 'f'.repeat(128) })).catch(() => undefined);
    // An unsigned request cannot be used to probe for a transaction.
    expect(ledger.findByProviderOrderId).not.toHaveBeenCalled();
    expect(ledger.recordWebhookNotification).not.toHaveBeenCalled();
  });
});

describe('PaymentWebhookService — unknown transaction', () => {
  it('acknowledges without creating anything', async () => {
    const { svc, ledger, logs } = harness({ transaction: null });
    const result = await svc.handleMidtransNotification(notification());

    expect(result).toEqual({ outcome: 'unknown_transaction', settlement: 'skipped' });
    expect(ledger.recordWebhookNotification).not.toHaveBeenCalled(); // no dedup row, no ledger write
    expect(logs.write).toHaveBeenCalledTimes(1);
    expect(logs.write.mock.calls[0][0].metadata).toEqual({
      provider: 'midtrans', providerOrderId: PROVIDER_ORDER_ID, reason: 'unknown_transaction',
    });
  });

  it('is indistinguishable from a processed one at the service boundary', async () => {
    // Both return normally; only the internal outcome differs, and the controller
    // collapses every 200 path to the same flat body.
    const unknown = await harness({ transaction: null }).svc.handleMidtransNotification(notification());
    const known = await harness().svc.handleMidtransNotification(notification());
    expect(Object.keys(unknown)).toEqual(Object.keys(known));
  });
});

describe('PaymentWebhookService — what it records', () => {
  it('passes the provider status through EXACTLY as received, unmapped', async () => {
    for (const status of ['settlement', 'capture', 'expire', 'deny', 'cancel', 'refund', 'pending']) {
      const { svc, ledger } = harness();
      await svc.handleMidtransNotification(notification({ transaction_status: status }));
      const input = ledger.recordWebhookNotification.mock.calls[0][0];

      expect(input.providerStatus).toBe(status); // verbatim, no enum, no mapping
      expect(input.transactionStatus).toBe(status);
    }
  });

  it('records the transaction id and the verbatim gross amount', async () => {
    const { svc, ledger } = harness();
    await svc.handleMidtransNotification(notification());
    const input = ledger.recordWebhookNotification.mock.calls[0][0];

    expect(input.providerTransactionId).toBe('a1b2c3');
    expect(input.grossAmount).toBe('130000.00'); // string, never a number
    expect(input.gatewayTransactionId).toBe(GTX_ID);
    expect(input.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(input.notifiedAt).toEqual(new Date(Date.UTC(2026, 7, 8, 10, 5, 0)));
  });

  it('fills in a missing provider transaction id but NEVER overwrites the charge value', async () => {
    const empty = harness({ transaction: { id: GTX_ID, paymentId: 'p', providerTransactionId: null } });
    await empty.svc.handleMidtransNotification(notification());
    expect(empty.ledger.recordWebhookNotification.mock.calls[0][0].fillProviderTransactionId).toBe('a1b2c3');

    const already = harness({ transaction: { id: GTX_ID, paymentId: 'p', providerTransactionId: 'charge-time-id' } });
    await already.svc.handleMidtransNotification(notification());
    // Overwriting could walk the @@unique([provider, providerTransactionId]) anchor
    // onto another attempt's id.
    expect(already.ledger.recordWebhookNotification.mock.calls[0][0].fillProviderTransactionId).toBeNull();
  });

  it('stores an ALLOWLISTED snapshot — signature_key and unknown fields excluded', () => {
    const dto = notification({
      // A field Midtrans might add tomorrow, and one that must never be persisted.
      ...({ card_token: 'tok_secret', some_future_field: 'x' } as Partial<MidtransWebhookDto>),
    });
    const snapshot = buildWebhookSnapshot(dto) as Record<string, string>;

    expect(snapshot.signature_key).toBeUndefined();
    expect(snapshot.card_token).toBeUndefined(); // allowlist, not denylist
    expect(snapshot.some_future_field).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(dto.signature_key);
    expect(JSON.stringify(snapshot)).not.toContain(SERVER_KEY);
    // …while every field the next phase needs is present.
    expect(snapshot).toMatchObject({
      order_id: PROVIDER_ORDER_ID, transaction_id: 'a1b2c3', transaction_status: 'settlement',
      status_code: '200', fraud_status: 'accept', gross_amount: GROSS,
    });
  });
});

describe('PaymentWebhookService — duplicate and stale deliveries', () => {
  it('a duplicate is a no-op that still acknowledges', async () => {
    const { svc, ledger } = harness({ outcome: 'duplicate' });
    const result = await svc.handleMidtransNotification(notification());

    expect(result).toEqual({ outcome: 'duplicate', settlement: 'already_processed' });
    expect(ledger.recordWebhookNotification).toHaveBeenCalledTimes(1); // one attempt, not a second write
  });

  it('100 identical deliveries all carry the SAME fingerprint', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { svc, ledger } = harness({ outcome: i === 0 ? 'applied' : 'duplicate' });
      await svc.handleMidtransNotification(notification());
      seen.add(ledger.recordWebhookNotification.mock.calls[0][0].fingerprint);
    }
    expect(seen.size).toBe(1); // → the unique index admits exactly one
  });

  it('a superseded notification is reported as stale, not as an error', async () => {
    const { svc, logs } = harness({ outcome: 'stale' });
    await expect(svc.handleMidtransNotification(notification()))
      .resolves.toEqual({ outcome: 'stale', settlement: 'already_processed' });
    expect(logs.write.mock.calls[0][0].metadata.reason).toBe('stale');
  });

  it('logs deduplicated=true only for a duplicate', async () => {
    const dup = harness({ outcome: 'duplicate' });
    await dup.svc.handleMidtransNotification(notification());
    expect(dup.logs.write.mock.calls[0][0].metadata.deduplicated).toBe(true);

    const applied = harness();
    await applied.svc.handleMidtransNotification(notification());
    expect(applied.logs.write.mock.calls[0][0].metadata.deduplicated).toBe(false);
  });
});

// ================================================ persistence semantics =====

/**
 * Exercises the real `recordWebhookNotification` against a Prisma double whose
 * `paymentWebhookEvent.create` enforces uniqueness the way the index does. This
 * proves the ALGORITHM (insert-first, single transaction, P2002 → duplicate,
 * rollback → key released). The constraint itself is proven against real MySQL in
 * test/integration/payment-webhook-idempotency.int-spec.ts.
 */
describe('PaymentGatewayPersistenceService.recordWebhookNotification', () => {
  const uniqueViolation = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: '6.19.3', meta: { target },
    });

  function fakePrisma(opts: { updateCount?: number; updateThrows?: Error } = {}) {
    const fingerprints = new Set<string>();
    const events: Record<string, unknown>[] = [];
    const updates: Record<string, unknown>[] = [];

    const tx = {
      paymentWebhookEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const fp = data.fingerprint as string;
          if (fingerprints.has(fp)) throw uniqueViolation(['fingerprint']);
          fingerprints.add(fp);
          events.push(data);
          return data;
        }),
      },
      paymentGatewayTransaction: {
        updateMany: jest.fn(async (args: Record<string, unknown>) => {
          if (opts.updateThrows) throw opts.updateThrows;
          updates.push(args);
          return { count: opts.updateCount ?? 1 };
        }),
      },
    };

    const prisma = {
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
        // Snapshot for rollback: a failed transaction must NOT retain the key.
        const before = new Set(fingerprints);
        const eventCount = events.length;
        try {
          return await fn(tx);
        } catch (err) {
          fingerprints.clear();
          before.forEach((f) => fingerprints.add(f));
          events.length = eventCount;
          throw err;
        }
      }),
    };
    return { prisma, tx, events, updates, fingerprints };
  }

  const input = (over: Record<string, unknown> = {}) => ({
    provider: 'midtrans',
    fingerprint: 'f'.repeat(64),
    gatewayTransactionId: GTX_ID,
    providerOrderId: PROVIDER_ORDER_ID,
    providerStatus: 'settlement',
    statusCode: '200',
    grossAmount: GROSS,
    notifiedAt: new Date('2026-08-08T10:05:00Z'),
    payload: { order_id: PROVIDER_ORDER_ID },
    ...over,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = (prisma: unknown) => new PaymentGatewayPersistenceService(prisma as any);

  it('first delivery: one dedup row + one ledger update, in ONE transaction', async () => {
    const f = fakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(svc(f.prisma).recordWebhookNotification(input() as any)).resolves.toBe('applied');

    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.events).toHaveLength(1);
    expect(f.updates).toHaveLength(1);
  });

  it('inserts the dedup row BEFORE the ledger update', async () => {
    const f = fakePrisma();
    const order: string[] = [];
    f.tx.paymentWebhookEvent.create.mockImplementation(async (a: { data: Record<string, unknown> }) => { order.push('dedup'); return a.data; });
    f.tx.paymentGatewayTransaction.updateMany.mockImplementation(async () => { order.push('ledger'); return { count: 1 }; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await svc(f.prisma).recordWebhookNotification(input() as any);
    expect(order).toEqual(['dedup', 'ledger']);
  });

  it('second delivery of the same fingerprint is a duplicate — ledger untouched', async () => {
    const f = fakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await svc(f.prisma).recordWebhookNotification(input() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(svc(f.prisma).recordWebhookNotification(input() as any)).resolves.toBe('duplicate');

    expect(f.events).toHaveLength(1); // exactly one dedup record
    expect(f.updates).toHaveLength(1); // ledger mutated once, not twice
  });

  it('a rolled-back attempt RELEASES the key — the retry succeeds', async () => {
    const failing = fakePrisma({ updateThrows: new Error('connection reset') });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(svc(failing.prisma).recordWebhookNotification(input() as any)).rejects.toThrow('connection reset');
    expect(failing.events).toHaveLength(0); // rolled back — nothing retained
    expect(failing.fingerprints.size).toBe(0);

    // Same notification again, now that the ledger write works.
    const retry = fakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(svc(retry.prisma).recordWebhookNotification(input() as any)).resolves.toBe('applied');
  });

  it('a NON-fingerprint unique violation is NOT swallowed as a duplicate', async () => {
    // Two attempts claiming one provider transaction id is a real data anomaly; it
    // must surface (5xx → provider retries → ops sees it), not be acked as a no-op.
    const f = fakePrisma({ updateThrows: uniqueViolation(['provider', 'providerTransactionId']) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(svc(f.prisma).recordWebhookNotification(input() as any)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('guards the ledger write against a strictly older notification', async () => {
    const f = fakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await svc(f.prisma).recordWebhookNotification(input() as any);

    const where = f.updates[0].where as { AND: Array<Record<string, unknown>> };
    expect(where.AND[0]).toEqual({ id: GTX_ID });
    expect(where.AND[1]).toEqual({
      OR: [{ providerStatusAt: null }, { providerStatusAt: { lte: new Date('2026-08-08T10:05:00Z') } }],
    });
  });

  it('applies no ordering guard when the notification time is unknown', async () => {
    const f = fakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await svc(f.prisma).recordWebhookNotification(input({ notifiedAt: null }) as any);

    const where = f.updates[0].where as { AND: Array<Record<string, unknown>> };
    expect(where.AND[1]).toEqual({}); // refuse to order rather than order wrongly
    expect((f.updates[0].data as Record<string, unknown>).providerStatusAt).toBeUndefined();
  });

  it('reports stale when the guard rejects the write — the event is still recorded', async () => {
    const f = fakePrisma({ updateCount: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(svc(f.prisma).recordWebhookNotification(input() as any)).resolves.toBe('stale');
    expect(f.events).toHaveLength(1); // nothing is ever lost: the log is append-only
  });

  it('writes ONLY gateway columns — no PaymentStatus, no OrderStatus', async () => {
    const f = fakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await svc(f.prisma).recordWebhookNotification(input() as any);

    expect(Object.keys(f.updates[0].data as object).sort()).toEqual(['providerStatus', 'providerStatusAt']);
    // `status` is our normalized enum — untouched, so no gateway→business mapping.
    expect((f.updates[0].data as Record<string, unknown>).status).toBeUndefined();
    expect(JSON.stringify(f.updates[0])).not.toContain('PAID');
  });
});
