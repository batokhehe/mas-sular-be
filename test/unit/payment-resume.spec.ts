import { NotFoundException } from '@nestjs/common';
import { GatewayTransactionStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { PaymentChannelRegistry } from '../../src/modules/payments/gateway/payment-channel.registry';
import { PaymentInitiationService } from '../../src/modules/payments/gateway/payment-initiation.service';
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory';
import { PaymentProvider } from '../../src/modules/payments/gateway/domain/payment-provider.interface';

/**
 * Phase 5J — RESUMING an existing QRIS payment.
 *
 * The invariant under test: a customer who closes the payment tab and comes back
 * later gets THE SAME attempt — same PaymentGatewayTransaction, same
 * providerOrderId, same QR string — and Midtrans is never contacted. Resume is a
 * ledger read; the only path that may open a charge is checkout.
 *
 * The second half proves the two server-side payability gates, because the
 * countdown the customer sees is presentation only: a tab can sit open past
 * expiry, and a browser can be pointed at a payment that has already settled.
 */

const NOW = Date.parse('2026-08-11T10:00:00.000Z');
const MINUTE = 60_000;

/** A persisted QRIS attempt, exactly as checkout left it. */
const ATTEMPT = {
  id: 'gtx-1',
  paymentId: 'pay-1',
  provider: 'midtrans',
  channelCode: 'QRIS',
  status: GatewayTransactionStatus.PENDING,
  grossAmount: 40_000,
  providerOrderId: 'BMS-20260811-001-a1b2c3d4', // Phase 5A: {orderNumber}-{attemptId8}
  providerReference: 'ref-1',
  providerTransactionId: 'txn-1',
  qrString: 'QRIS-PAYLOAD-PERSISTED-AT-CHECKOUT',
  vaNumber: null,
  redirectUrl: null,
  deeplinkUrl: null,
  expiryAt: new Date(NOW + 15 * MINUTE),
};

/**
 * A live provider registered under the same name the attempt carries. Every
 * outbound method is a spy, so "the gateway was not contacted" is an assertion
 * about the real seam rather than about an absent collaborator.
 */
function spyProvider() {
  return {
    name: 'midtrans',
    supportedChannels: () => ['QRIS'],
    createCharge: jest.fn(),
    getStatus: jest.fn(),
    cancel: jest.fn(),
    mapStatus: jest.fn(),
  };
}

function build(over: { payment?: Record<string, unknown> | null; attempt?: Record<string, unknown> | null } = {}) {
  const provider = spyProvider();
  const factory = new PaymentProviderFactory([provider as unknown as PaymentProvider]);
  const registry = new PaymentChannelRegistry(factory);

  const payment =
    over.payment === null
      ? null
      : { id: 'pay-1', status: PaymentStatus.PENDING, ...(over.payment ?? {}) };

  const prisma = { payment: { findFirst: jest.fn().mockResolvedValue(payment) } };

  const attempt = over.attempt === null ? null : { ...ATTEMPT, ...(over.attempt ?? {}) };

  // Every WRITE the ledger can perform is spied, so a resume that mutated
  // anything would fail loudly instead of silently forking the payment.
  const ledger = {
    findLatestByPayment: jest.fn().mockResolvedValue(attempt),
    createPendingTransaction: jest.fn(),
    updateGatewayResponse: jest.fn(),
    markFailed: jest.fn(),
  };

  const service = new PaymentInitiationService(
    prisma as never,
    registry,
    factory,
    ledger as never,
  );
  return { service, prisma, ledger, provider, attempt };
}

/** No provider call, and nothing written — the whole point of resume. */
function expectReadOnly(world: ReturnType<typeof build>) {
  expect(world.provider.createCharge).not.toHaveBeenCalled();
  expect(world.provider.getStatus).not.toHaveBeenCalled();
  expect(world.provider.cancel).not.toHaveBeenCalled();
  expect(world.ledger.createPendingTransaction).not.toHaveBeenCalled();
  expect(world.ledger.updateGatewayResponse).not.toHaveBeenCalled();
  expect(world.ledger.markFailed).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
});

// ================================================== the resume happy path ====

describe('resuming an open QRIS payment', () => {
  it('returns the persisted attempt to its owner', async () => {
    const world = build();
    const result = await world.service.getInstructions('pay-1', 'user-1');

    expect(result.status).toBe(PaymentStatus.PENDING);
    expect(result.expired).toBe(false);
    expect(result.gateway).not.toBeNull();
    expect(result.gateway).toMatchObject({
      paymentMethod: PaymentMethod.GATEWAY,
      paymentChannel: 'QRIS',
      provider: 'midtrans',
      providerStatus: GatewayTransactionStatus.PENDING,
    });
  });

  it('hands back EXACTLY the stored QR data — nothing is regenerated', async () => {
    const world = build();
    const { gateway } = await world.service.getInstructions('pay-1', 'user-1');

    expect(gateway!.qrString).toBe(ATTEMPT.qrString);
    expect(gateway!.expiryAt).toBe(ATTEMPT.expiryAt.toISOString());
    expect(gateway!.paymentInstruction).toMatchObject({
      type: 'QR',
      amount: ATTEMPT.grossAmount,
      qrString: ATTEMPT.qrString,
    });
  });

  it('never contacts the gateway and never writes to the ledger', async () => {
    const world = build();
    await world.service.getInstructions('pay-1', 'user-1');
    expectReadOnly(world);
    // The ONLY ledger call resume may make is the read.
    expect(world.ledger.findLatestByPayment).toHaveBeenCalledTimes(1);
    expect(world.ledger.findLatestByPayment).toHaveBeenCalledWith('pay-1');
  });

  it('leaves providerOrderId untouched — no new correlation id is minted', async () => {
    const world = build();
    await world.service.getInstructions('pay-1', 'user-1');

    // The stored row is the same object the ledger handed over, unmodified.
    expect(world.attempt!.providerOrderId).toBe(ATTEMPT.providerOrderId);
    expect(world.attempt!.id).toBe('gtx-1');
    expectReadOnly(world);
  });

  it('is stable across repeated resumes — many tabs, still zero charges', async () => {
    const world = build();
    const first = await world.service.getInstructions('pay-1', 'user-1');
    const second = await world.service.getInstructions('pay-1', 'user-1');
    const third = await world.service.getInstructions('pay-1', 'user-1');

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expectReadOnly(world);
  });
});

// ========================================================= ownership (§6) ====

describe('ownership', () => {
  it('scopes the lookup to the caller through the order relation', async () => {
    const world = build();
    await world.service.getInstructions('pay-1', 'user-1');

    expect(world.prisma.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay-1', deletedAt: null, order: { userId: 'user-1' } },
      }),
    );
  });

  it("404s on another customer's payment, and reads no ledger row", async () => {
    // The ownership-scoped query returns nothing for a payment the caller does
    // not own — indistinguishable from a payment that does not exist.
    const world = build({ payment: null });

    await expect(world.service.getInstructions('pay-1', 'attacker')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(world.ledger.findLatestByPayment).not.toHaveBeenCalled();
    expectReadOnly(world);
  });
});

// ============================================= gate 1: payment status (§B) ===

describe('only a PENDING payment is payable', () => {
  it('a PAID payment NEVER returns a scannable QR', async () => {
    const world = build({ payment: { status: PaymentStatus.PAID } });
    const result = await world.service.getInstructions('pay-1', 'user-1');

    expect(result.gateway).toBeNull();
    expect(result.status).toBe(PaymentStatus.PAID);
    expect(result.expired).toBe(false);
    // Settled payments short-circuit before the ledger is even read.
    expect(world.ledger.findLatestByPayment).not.toHaveBeenCalled();
    expectReadOnly(world);
  });

  it.each([
    [PaymentStatus.FAILED],
    [PaymentStatus.EXPIRED],
    [PaymentStatus.REFUNDED],
    [PaymentStatus.WAITING_VERIFICATION],
  ])('%s returns no payable instructions', async (status) => {
    const world = build({ payment: { status } });
    const result = await world.service.getInstructions('pay-1', 'user-1');

    expect(result.gateway).toBeNull();
    expect(result.status).toBe(status);
    expectReadOnly(world);
  });
});

// ==================================================== gate 2: expiry (§C) ====

describe('the server owns expiry', () => {
  it('a PENDING attempt still inside its window is payable', async () => {
    const world = build({ attempt: { expiryAt: new Date(NOW + MINUTE) } });
    const result = await world.service.getInstructions('pay-1', 'user-1');

    expect(result.gateway).not.toBeNull();
    expect(result.expired).toBe(false);
  });

  it('a PENDING attempt past its window is NOT payable, even before the worker runs', async () => {
    // Payment.status is still PENDING here — exactly the window between the
    // provider deadline and the lifecycle worker flipping the row.
    const world = build({ attempt: { expiryAt: new Date(NOW - MINUTE) } });
    const result = await world.service.getInstructions('pay-1', 'user-1');

    expect(result.gateway).toBeNull();
    expect(result.expired).toBe(true);
    expect(result.status).toBe(PaymentStatus.PENDING);
    // It must not quietly re-charge to replace the dead QR.
    expectReadOnly(world);
  });

  it('treats the exact expiry instant as elapsed', async () => {
    const world = build({ attempt: { expiryAt: new Date(NOW) } });
    await expect(world.service.getInstructions('pay-1', 'user-1')).resolves.toMatchObject({
      gateway: null,
      expired: true,
    });
  });

  it('a channel with no deadline is not treated as expired', async () => {
    const world = build({ attempt: { expiryAt: null } });
    const result = await world.service.getInstructions('pay-1', 'user-1');

    expect(result.gateway).not.toBeNull();
    expect(result.expired).toBe(false);
  });
});

// ============================================ manual transfer is untouched ===

describe('manual BANK_TRANSFER behavior is unchanged', () => {
  it('a payment with no gateway attempt yields gateway: null, as before', async () => {
    const world = build({ attempt: null });
    const result = await world.service.getInstructions('pay-1', 'user-1');

    expect(result.gateway).toBeNull();
    expect(result.expired).toBe(false);
    expect(result.status).toBe(PaymentStatus.PENDING);
    expectReadOnly(world);
  });

  it('a WAITING_VERIFICATION manual payment still reports its status', async () => {
    // The receipt-upload flow lives on the order list and reads Payment.status;
    // this endpoint simply reports it and offers nothing payable.
    const world = build({ payment: { status: PaymentStatus.WAITING_VERIFICATION }, attempt: null });
    const result = await world.service.getInstructions('pay-1', 'user-1');

    expect(result).toEqual({
      gateway: null,
      status: PaymentStatus.WAITING_VERIFICATION,
      expired: false,
    });
  });

  it('an attempt on an unknown channel code degrades to gateway: null', async () => {
    const world = build({ attempt: { channelCode: 'NOT_A_CHANNEL' } });
    await expect(world.service.getInstructions('pay-1', 'user-1')).resolves.toMatchObject({
      gateway: null,
    });
  });
});

// ================================================= the response contract =====

describe('the response contract', () => {
  it('always carries gateway, status and expired', async () => {
    const world = build();
    const result = await world.service.getInstructions('pay-1', 'user-1');
    expect(Object.keys(result).sort()).toEqual(['expired', 'gateway', 'status']);
  });

  it('never exposes the raw provider response or ledger internals', async () => {
    const world = build();
    const { gateway } = await world.service.getInstructions('pay-1', 'user-1');
    const keys = Object.keys(gateway!);

    expect(keys).not.toContain('rawResponse');
    expect(keys).not.toContain('providerOrderId');
    expect(keys).not.toContain('providerTransactionId');
  });
});
