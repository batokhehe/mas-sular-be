import { GatewayTransactionStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { ManualTransferProvider } from '../../src/modules/payments/gateway/infrastructure/providers/manual-transfer.provider';
import { MidtransPaymentProvider } from '../../src/modules/payments/gateway/infrastructure/providers/midtrans-payment.provider';
import { MidtransConfig } from '../../src/modules/payments/gateway/midtrans.config';
import { PaymentChannelRegistry } from '../../src/modules/payments/gateway/payment-channel.registry';
import { PaymentGatewayPersistenceService } from '../../src/modules/payments/gateway/payment-gateway-persistence.service';
import { PaymentInitiationService } from '../../src/modules/payments/gateway/payment-initiation.service';
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory';

/**
 * Phase 5A — the webhook correlation invariant:
 *   GatewayTransaction.providerOrderId === the order_id sent to Midtrans.
 *
 * Before this phase the ledger stored the BARE order number while Midtrans was
 * charged with `{orderNumber}-{attemptId8}`, so no inbound notification could
 * ever be matched back to its attempt.
 */

const CONFIG: MidtransConfig = {
  enabled: true,
  serverKey: 'SB-Mid-server-TEST',
  clientKey: 'ck',
  isProduction: false,
  baseUrl: 'https://api.sandbox.midtrans.com',
  timeoutMs: 5000,
  maxRetry: 0,
};

const ORDER_NUMBER = 'BMS-20260712-001';
const ATTEMPT_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const ATTEMPT_B = 'bbbbbbbb-5555-6666-7777-888888888888';

/** Midtrans provider wired to a stub transport that records the charge body. */
function midtrans(transactionId = 'trx-9') {
  const calls: Array<Record<string, unknown>> = [];
  const provider = new MidtransPaymentProvider(CONFIG);
  const http = async (_url: string, init: Record<string, unknown>) => {
    calls.push(JSON.parse(init.body as string));
    return {
      status: 201,
      text: async () =>
        JSON.stringify({
          status_code: '201',
          transaction_id: transactionId,
          transaction_status: 'pending',
          payment_type: 'qris',
          qr_string: 'QR',
        }),
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider.setHttpClient(http as any);
  return { provider, calls };
}

const sentOrderId = (calls: Array<Record<string, unknown>>): string =>
  (calls[0].transaction_details as { order_id: string }).order_id;

describe('Phase 5A — Midtrans order_id carries the attempt suffix', () => {
  const base = {
    paymentId: 'pay-1',
    orderId: 'o-1',
    orderNumber: ORDER_NUMBER,
    amount: 130000,
    channel: 'QRIS' as const,
    customer: { name: 'Budi', email: 'b@t.com', phone: null },
  };

  it('sends {orderNumber}-{attemptId8} as transaction_details.order_id', async () => {
    const { provider, calls } = midtrans();
    await provider.createCharge({ ...base, attemptId: ATTEMPT_A });
    expect(sentOrderId(calls)).toBe(`${ORDER_NUMBER}-aaaaaaaa`);
  });

  it('returns that exact value as ChargeResult.providerOrderId — nothing to reconstruct', async () => {
    const { provider, calls } = midtrans();
    const result = await provider.createCharge({ ...base, attemptId: ATTEMPT_A });
    expect(result.providerOrderId).toBe(sentOrderId(calls));
    expect(result.providerOrderId).not.toBe(ORDER_NUMBER); // never the bare order number
  });

  it('two attempts on the same order produce two DIFFERENT order ids', async () => {
    const a = midtrans();
    const b = midtrans();
    const first = await a.provider.createCharge({ ...base, attemptId: ATTEMPT_A });
    const second = await b.provider.createCharge({ ...base, attemptId: ATTEMPT_B });

    expect(first.providerOrderId).toBe(`${ORDER_NUMBER}-aaaaaaaa`);
    expect(second.providerOrderId).toBe(`${ORDER_NUMBER}-bbbbbbbb`);
    expect(first.providerOrderId).not.toBe(second.providerOrderId);
  });
});

describe('Phase 5A — the ledger stores exactly what was charged', () => {
  function initiation(attemptId: string) {
    const { provider, calls } = midtrans();
    const factory = new PaymentProviderFactory([provider]);
    const registry = new PaymentChannelRegistry(factory);
    const prisma = {
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'pay-1',
          orderId: 'o-1',
          method: PaymentMethod.GATEWAY,
          status: PaymentStatus.PENDING,
          amount: 130000,
          order: { orderNumber: ORDER_NUMBER, user: { name: 'Budi', email: null, phone: null } },
        }),
      },
    };
    const ledger = {
      createPendingTransaction: jest.fn().mockResolvedValue({ id: attemptId }),
      updateGatewayResponse: jest.fn().mockResolvedValue({}),
      markFailed: jest.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new PaymentInitiationService(prisma as any, registry, factory, ledger as any);
    return { service, ledger, calls };
  }

  it('persists providerOrderId === the order_id Midtrans actually received', async () => {
    const { service, ledger, calls } = initiation(ATTEMPT_A);
    await service.initiate('pay-1', 'QRIS');

    const persisted = ledger.updateGatewayResponse.mock.calls[0][1].providerOrderId;
    expect(persisted).toBe(sentOrderId(calls));
    expect(persisted).toBe(`${ORDER_NUMBER}-aaaaaaaa`);
  });

  it('corrects the placeholder written before the charge (final value is never the bare number)', async () => {
    const { service, ledger } = initiation(ATTEMPT_A);
    await service.initiate('pay-1', 'QRIS');

    // The row is opened before the provider exists to build an id, so step 3
    // writes a placeholder…
    expect(ledger.createPendingTransaction.mock.calls[0][0].providerOrderId).toBe(ORDER_NUMBER);
    // …and step 5b overwrites it with the real one.
    expect(ledger.updateGatewayResponse.mock.calls[0][1].providerOrderId).not.toBe(ORDER_NUMBER);
  });

  it('manual transfer is untouched — no gateway order id, so nothing is overwritten', async () => {
    const manualPrisma = {
      payment: { findUnique: jest.fn().mockResolvedValue({ status: PaymentStatus.PENDING, uniqueCode: 321 }) },
    };
    const accounts = {
      getActiveAccount: jest.fn().mockResolvedValue({
        id: 'acc-1', bankName: 'BCA', bankCode: '014', accountName: 'Mas Sular', accountNumber: '1234567890',
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const manual = new ManualTransferProvider(manualPrisma as any, accounts as any);
    const factory = new PaymentProviderFactory([manual]);
    const registry = new PaymentChannelRegistry(factory);
    const prisma = {
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'pay-1',
          orderId: 'o-1',
          method: PaymentMethod.BANK_TRANSFER,
          status: PaymentStatus.PENDING,
          amount: 130321,
          order: { orderNumber: ORDER_NUMBER, user: { name: 'Budi', email: null, phone: null } },
        }),
      },
    };
    const ledger = {
      createPendingTransaction: jest.fn().mockResolvedValue({ id: 'gtx-1' }),
      updateGatewayResponse: jest.fn().mockResolvedValue({}),
      markFailed: jest.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new PaymentInitiationService(prisma as any, registry, factory, ledger as any);

    await service.initiate('pay-1', 'MANUAL_TRANSFER');

    // No providerOrderId key is written at all → the placeholder stands untouched.
    expect(ledger.updateGatewayResponse.mock.calls[0][1]).not.toHaveProperty('providerOrderId');
  });
});

describe('Phase 5A — indexed correlation lookup', () => {
  function ledgerPrisma(row: unknown) {
    const gtx = { findFirst: jest.fn().mockResolvedValue(row) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new PaymentGatewayPersistenceService({ paymentGatewayTransaction: gtx } as any);
    return { service, gtx };
  }

  it('findByProviderOrderId queries the indexed (provider, providerOrderId) pair', async () => {
    const row = {
      id: 'gtx-1', provider: 'midtrans', providerOrderId: `${ORDER_NUMBER}-aaaaaaaa`,
      status: GatewayTransactionStatus.PENDING,
    };
    const { service, gtx } = ledgerPrisma(row);

    await expect(service.findByProviderOrderId('midtrans', `${ORDER_NUMBER}-aaaaaaaa`)).resolves.toBe(row);
    expect(gtx.findFirst).toHaveBeenCalledWith({
      where: { provider: 'midtrans', providerOrderId: `${ORDER_NUMBER}-aaaaaaaa` },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('is provider-scoped — a different provider never matches the same order id', async () => {
    const { service, gtx } = ledgerPrisma(null);
    await expect(service.findByProviderOrderId('xendit', `${ORDER_NUMBER}-aaaaaaaa`)).resolves.toBeNull();
    expect(gtx.findFirst.mock.calls[0][0].where.provider).toBe('xendit');
  });

  it('returns null for an unknown order id (a webhook must never guess)', async () => {
    const { service } = ledgerPrisma(null);
    await expect(service.findByProviderOrderId('midtrans', 'NOPE')).resolves.toBeNull();
  });
});

// ================== 5H.2 §11-J: a gateway failure must not corrupt checkout ==

describe('a failed Core API charge leaves the order intact', () => {
  function failingInitiation(error: Error) {
    const provider = {
      name: 'midtrans',
      supportedChannels: () => ['QRIS' as const],
      createCharge: jest.fn(async () => { throw error; }),
      getStatus: jest.fn(),
      cancel: jest.fn(),
      mapStatus: () => PaymentStatus.PENDING,
    };
    const factory = new PaymentProviderFactory([provider as never]);
    const registry = new PaymentChannelRegistry(factory);
    const prisma = {
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'pay-1', orderId: 'o-1', method: PaymentMethod.GATEWAY,
          status: PaymentStatus.PENDING, amount: 130000,
          order: { orderNumber: 'BMS-FAIL-1', user: { name: 'Budi', email: null, phone: null } },
        }),
        // Present so an accidental mutation would be visible in the assertions.
        update: jest.fn(), updateMany: jest.fn(), delete: jest.fn(),
      },
      order: { update: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
    };
    const ledger = {
      createPendingTransaction: jest.fn().mockResolvedValue({ id: 'attempt-fail' }),
      updateGatewayResponse: jest.fn(),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new PaymentInitiationService(prisma as any, registry, factory, ledger as any);
    return { service, ledger, prisma, provider };
  }

  it('marks the attempt FAILED, rethrows untouched, and mutates no order or payment', async () => {
    const boom = new Error('midtrans status_code 402: Payment channel is not activated.');
    const { service, ledger, prisma } = failingInitiation(boom);

    // The caller's error contract is unchanged — the same error propagates.
    await expect(service.initiate('pay-1', 'QRIS')).rejects.toBe(boom);

    // The attempt is recorded as failed…
    expect(ledger.markFailed).toHaveBeenCalledWith('attempt-fail', boom.message);
    // …and nothing writes the provider response.
    expect(ledger.updateGatewayResponse).not.toHaveBeenCalled();

    // The already-created order and payment are never rolled back or deleted:
    // checkout committed them before the charge was attempted.
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.delete).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.delete).not.toHaveBeenCalled();
  });

  it('a failure to record the failure still rethrows the original error', async () => {
    const boom = new Error('gateway timeout');
    const { service, ledger } = failingInitiation(boom);
    ledger.markFailed.mockRejectedValue(new Error('ledger unavailable'));

    // The bookkeeping problem must never mask the real cause for the caller.
    await expect(service.initiate('pay-1', 'QRIS')).rejects.toBe(boom);
  });
});
