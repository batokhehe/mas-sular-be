import { GatewayTransactionStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import {
  isTerminalGatewayStatus,
  mapGatewayStatusToPaymentStatus,
} from '../../src/modules/payments/gateway/domain/gateway-status.mapper';
import { ManualTransferProvider } from '../../src/modules/payments/gateway/infrastructure/providers/manual-transfer.provider';
import { PaymentChannelRegistry } from '../../src/modules/payments/gateway/payment-channel.registry';
import { PaymentGatewayPersistenceService } from '../../src/modules/payments/gateway/payment-gateway-persistence.service';
import { PaymentInitiationService } from '../../src/modules/payments/gateway/payment-initiation.service';
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory';

function ledgerPrisma(existing: unknown = null) {
  const gtx = {
    findFirst: jest.fn().mockResolvedValue(existing),
    create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'gtx-new', ...data })),
    update: jest.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: unknown }) => ({ id: where.id, ...(data as object) })),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prisma: { paymentGatewayTransaction: gtx } as any, gtx };
}

const BASE = {
  paymentId: 'pay-1',
  provider: 'manual',
  channelCode: 'MANUAL_TRANSFER',
  grossAmount: 130321,
};

describe('gateway status mapper (prepared, not yet wired)', () => {
  it('maps every provider status into the existing PaymentStatus vocabulary', () => {
    expect(mapGatewayStatusToPaymentStatus(GatewayTransactionStatus.PENDING)).toBe(PaymentStatus.PENDING);
    expect(mapGatewayStatusToPaymentStatus(GatewayTransactionStatus.CAPTURED)).toBe(PaymentStatus.PAID);
    expect(mapGatewayStatusToPaymentStatus(GatewayTransactionStatus.SETTLEMENT)).toBe(PaymentStatus.PAID);
    expect(mapGatewayStatusToPaymentStatus(GatewayTransactionStatus.FAILED)).toBe(PaymentStatus.FAILED);
    expect(mapGatewayStatusToPaymentStatus(GatewayTransactionStatus.EXPIRED)).toBe(PaymentStatus.EXPIRED);
    expect(mapGatewayStatusToPaymentStatus(GatewayTransactionStatus.CANCELLED)).toBe(PaymentStatus.FAILED);
    expect(mapGatewayStatusToPaymentStatus(GatewayTransactionStatus.REFUNDED)).toBe(PaymentStatus.REFUNDED);
  });

  it('AUTHORIZED is NOT money — it must never map to PAID', () => {
    expect(mapGatewayStatusToPaymentStatus(GatewayTransactionStatus.AUTHORIZED)).toBe(PaymentStatus.PENDING);
  });

  it('is exhaustive over the enum (a new status cannot be silently unmapped)', () => {
    for (const status of Object.values(GatewayTransactionStatus)) {
      expect(Object.values(PaymentStatus)).toContain(mapGatewayStatusToPaymentStatus(status));
    }
  });

  it('classifies terminal provider statuses', () => {
    expect(isTerminalGatewayStatus(GatewayTransactionStatus.SETTLEMENT)).toBe(true);
    expect(isTerminalGatewayStatus(GatewayTransactionStatus.REFUNDED)).toBe(true);
    expect(isTerminalGatewayStatus(GatewayTransactionStatus.PENDING)).toBe(false);
    expect(isTerminalGatewayStatus(GatewayTransactionStatus.AUTHORIZED)).toBe(false);
  });
});

describe('PaymentGatewayPersistenceService — createPendingTransaction', () => {
  it('opens a PENDING row with defaults (IDR) and the supplied snapshot fields', async () => {
    const { prisma, gtx } = ledgerPrisma();
    const service = new PaymentGatewayPersistenceService(prisma);

    await service.createPendingTransaction({ ...BASE, providerOrderId: 'BMS-1', metadata: { a: 1 } });

    expect(gtx.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: 'pay-1',
        provider: 'manual',
        channelCode: 'MANUAL_TRANSFER',
        grossAmount: 130321,
        currency: 'IDR',
        providerOrderId: 'BMS-1',
        status: GatewayTransactionStatus.PENDING,
      }),
    });
  });

  it('duplicate protection: replaying the SAME payment+provider+channel returns the live row', async () => {
    const live = { id: 'gtx-live', paymentId: 'pay-1', provider: 'manual', channelCode: 'MANUAL_TRANSFER', status: GatewayTransactionStatus.PENDING };
    const { prisma, gtx } = ledgerPrisma(live);
    const service = new PaymentGatewayPersistenceService(prisma);

    const result = await service.createPendingTransaction(BASE);

    expect(result).toBe(live);
    expect(gtx.create).not.toHaveBeenCalled(); // no second attempt row
    expect(gtx.updateMany).not.toHaveBeenCalled();
  });

  it('switching channel cancels the previous live attempt, then opens a new one', async () => {
    const live = { id: 'gtx-live', paymentId: 'pay-1', provider: 'midtrans', channelCode: 'QRIS', status: GatewayTransactionStatus.PENDING };
    const { prisma, gtx } = ledgerPrisma(live);
    const service = new PaymentGatewayPersistenceService(prisma);

    await service.createPendingTransaction({ ...BASE, provider: 'midtrans', channelCode: 'GOPAY' });

    expect(gtx.updateMany).toHaveBeenCalledWith({
      where: { id: 'gtx-live', status: { in: [GatewayTransactionStatus.PENDING, GatewayTransactionStatus.AUTHORIZED] } },
      data: expect.objectContaining({ status: GatewayTransactionStatus.CANCELLED }),
    });
    expect(gtx.create).toHaveBeenCalledTimes(1); // exactly one live attempt remains
  });

  it('only PENDING/AUTHORIZED rows count as live (a settled attempt never blocks a new one)', async () => {
    const { prisma, gtx } = ledgerPrisma();
    const service = new PaymentGatewayPersistenceService(prisma);
    await service.createPendingTransaction(BASE);
    expect(gtx.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paymentId: 'pay-1', status: { in: [GatewayTransactionStatus.PENDING, GatewayTransactionStatus.AUTHORIZED] } },
      }),
    );
  });
});

describe('PaymentGatewayPersistenceService — provider response persistence', () => {
  it('writes only the fields the provider actually returned', async () => {
    const { prisma, gtx } = ledgerPrisma();
    const service = new PaymentGatewayPersistenceService(prisma);

    await service.updateGatewayResponse('gtx-1', {
      status: GatewayTransactionStatus.PENDING,
      providerReference: 'trx-9',
      vaNumber: '8808123',
      expiryAt: new Date('2026-07-11T00:00:00Z'),
    });

    const data = gtx.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: GatewayTransactionStatus.PENDING, providerReference: 'trx-9', vaNumber: '8808123' });
    // Untouched fields must not be written as undefined/null.
    expect(data).not.toHaveProperty('qrString');
    expect(data).not.toHaveProperty('redirectUrl');
    expect(data).not.toHaveProperty('failureReason');
  });

  it('distinguishes "omitted" from "explicitly null"', async () => {
    const { prisma, gtx } = ledgerPrisma();
    const service = new PaymentGatewayPersistenceService(prisma);
    await service.updateGatewayResponse('gtx-1', { qrString: null });
    expect(gtx.update.mock.calls[0][0].data).toHaveProperty('qrString', null);
  });
});

describe('PaymentGatewayPersistenceService — status transitions', () => {
  it('markSuccess CAS-guards on a non-terminal row', async () => {
    const { prisma, gtx } = ledgerPrisma();
    const service = new PaymentGatewayPersistenceService(prisma);

    await expect(service.markSuccess('gtx-1', { providerTransactionId: 'trx-9' })).resolves.toEqual({ changed: true });

    const call = gtx.updateMany.mock.calls[0][0];
    expect(call.where.id).toBe('gtx-1');
    expect(call.data).toMatchObject({ status: GatewayTransactionStatus.SETTLEMENT, providerTransactionId: 'trx-9' });
    // Guard excludes every terminal status and permits the two live ones
    // (order is enum-declaration order, so compare as sets).
    expect(new Set(call.where.status.notIn)).toEqual(new Set([
      GatewayTransactionStatus.CAPTURED, GatewayTransactionStatus.SETTLEMENT, GatewayTransactionStatus.FAILED,
      GatewayTransactionStatus.EXPIRED, GatewayTransactionStatus.CANCELLED, GatewayTransactionStatus.REFUNDED,
    ]));
    expect(call.where.status.notIn).not.toContain(GatewayTransactionStatus.PENDING);
    expect(call.where.status.notIn).not.toContain(GatewayTransactionStatus.AUTHORIZED);
  });

  it('markSuccess can record CAPTURED instead of SETTLEMENT (card flows)', async () => {
    const { prisma, gtx } = ledgerPrisma();
    const service = new PaymentGatewayPersistenceService(prisma);
    await service.markSuccess('gtx-1', { status: GatewayTransactionStatus.CAPTURED });
    expect(gtx.updateMany.mock.calls[0][0].data.status).toBe(GatewayTransactionStatus.CAPTURED);
  });

  it('markExpired / markFailed transition and truncate the failure reason', async () => {
    const { prisma, gtx } = ledgerPrisma();
    const service = new PaymentGatewayPersistenceService(prisma);

    await service.markExpired('gtx-1');
    expect(gtx.updateMany.mock.calls[0][0].data.status).toBe(GatewayTransactionStatus.EXPIRED);

    await service.markFailed('gtx-2', 'x'.repeat(900));
    const failData = gtx.updateMany.mock.calls[1][0].data;
    expect(failData.status).toBe(GatewayTransactionStatus.FAILED);
    expect(failData.failureReason).toHaveLength(512); // column bound respected
  });

  it('a lost CAS (already terminal / row gone) reports changed:false and never throws', async () => {
    const { prisma, gtx } = ledgerPrisma();
    gtx.updateMany.mockResolvedValue({ count: 0 });
    const service = new PaymentGatewayPersistenceService(prisma);

    await expect(service.markSuccess('gtx-1')).resolves.toEqual({ changed: false });
    await expect(service.markExpired('gtx-1')).resolves.toEqual({ changed: false });
    await expect(service.markFailed('gtx-1', 'boom')).resolves.toEqual({ changed: false });
  });
});

describe('PaymentGatewayPersistenceService — lookups', () => {
  it('findLatestByPayment returns the newest attempt', async () => {
    const { prisma, gtx } = ledgerPrisma({ id: 'gtx-latest' });
    const service = new PaymentGatewayPersistenceService(prisma);

    await expect(service.findLatestByPayment('pay-1')).resolves.toMatchObject({ id: 'gtx-latest' });
    expect(gtx.findFirst).toHaveBeenCalledWith({ where: { paymentId: 'pay-1' }, orderBy: { createdAt: 'desc' } });
  });

  it('findByProviderReference is provider-scoped (references are unique per provider only)', async () => {
    const { prisma, gtx } = ledgerPrisma({ id: 'gtx-ref' });
    const service = new PaymentGatewayPersistenceService(prisma);

    await service.findByProviderReference('midtrans', 'trx-9');
    expect(gtx.findFirst).toHaveBeenCalledWith({
      where: { provider: 'midtrans', providerReference: 'trx-9' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns null when nothing matches', async () => {
    const { prisma } = ledgerPrisma(null);
    const service = new PaymentGatewayPersistenceService(prisma);
    await expect(service.findLatestByPayment('nope')).resolves.toBeNull();
    await expect(service.findByProviderReference('midtrans', 'nope')).resolves.toBeNull();
  });
});

describe('PaymentInitiationService — persistence integration', () => {
  const ACCOUNT = { id: 'acc-1', bankName: 'BCA', bankCode: '014', accountName: 'Mas Sular', accountNumber: '1234567890' };
  const PAYMENT = {
    id: 'pay-1', orderId: 'o-1', method: PaymentMethod.BANK_TRANSFER, status: PaymentStatus.PENDING, amount: 130321,
    order: { orderNumber: 'BMS-1', user: { name: 'Budi', email: 'b@t.com', phone: '628' } },
  };

  function build(opts: { chargeThrows?: boolean } = {}) {
    const providerPrisma = {
      payment: { findUnique: jest.fn().mockResolvedValue({ status: PaymentStatus.PENDING, uniqueCode: 321 }) },
    };
    const accounts = { getActiveAccount: jest.fn().mockResolvedValue(ACCOUNT) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const provider = new ManualTransferProvider(providerPrisma as any, accounts as any);
    if (opts.chargeThrows) {
      jest.spyOn(provider, 'createCharge').mockRejectedValue(new Error('provider exploded'));
    }
    const factory = new PaymentProviderFactory([provider]);
    const registry = new PaymentChannelRegistry(factory);
    const prisma = { payment: { findFirst: jest.fn().mockResolvedValue(PAYMENT) } };
    const ledger = {
      createPendingTransaction: jest.fn().mockResolvedValue({ id: 'gtx-1' }),
      updateGatewayResponse: jest.fn().mockResolvedValue({ id: 'gtx-1' }),
      markFailed: jest.fn().mockResolvedValue({ changed: true }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new PaymentInitiationService(prisma as any, registry, factory, ledger as any);
    return { service, ledger, prisma, provider };
  }

  it('opens the ledger row BEFORE charging, then persists the provider response', async () => {
    const { service, ledger, provider } = build();
    const chargeSpy = jest.spyOn(provider, 'createCharge');

    const result = await service.initiate('pay-1', 'MANUAL_TRANSFER');

    // Ordering: pending row → provider call → response persisted.
    expect(ledger.createPendingTransaction.mock.invocationCallOrder[0])
      .toBeLessThan(chargeSpy.mock.invocationCallOrder[0]);
    expect(chargeSpy.mock.invocationCallOrder[0])
      .toBeLessThan(ledger.updateGatewayResponse.mock.invocationCallOrder[0]);

    expect(ledger.createPendingTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pay-1', provider: 'manual', channelCode: 'MANUAL_TRANSFER', grossAmount: 130321, providerOrderId: 'BMS-1' }),
    );
    expect(ledger.updateGatewayResponse).toHaveBeenCalledWith('gtx-1', expect.objectContaining({
      status: GatewayTransactionStatus.PENDING,
      providerReference: 'pay-1',
      providerTransactionId: 'pay-1',
    }));
    expect(result).toMatchObject({ provider: 'manual', channel: 'MANUAL_TRANSFER' });
  });

  it('records the failure on the attempt and rethrows unchanged when the provider throws', async () => {
    const { service, ledger } = build({ chargeThrows: true });

    await expect(service.initiate('pay-1', 'MANUAL_TRANSFER')).rejects.toThrow('provider exploded');
    expect(ledger.markFailed).toHaveBeenCalledWith('gtx-1', 'provider exploded');
    expect(ledger.updateGatewayResponse).not.toHaveBeenCalled();
  });

  it('never writes to the ledger when a guard rejects the request', async () => {
    const { service, ledger, prisma } = build();
    prisma.payment.findFirst.mockResolvedValue({ ...PAYMENT, status: PaymentStatus.PAID });

    await expect(service.initiate('pay-1', 'MANUAL_TRANSFER')).rejects.toThrow();
    expect(ledger.createPendingTransaction).not.toHaveBeenCalled();
  });

  it('never touches the Payment row (business status stays owned by the existing flows)', async () => {
    const { service, prisma } = build();
    await service.initiate('pay-1', 'MANUAL_TRANSFER');
    expect(Object.keys(prisma.payment)).toEqual(['findFirst']); // read-only surface
  });
});
