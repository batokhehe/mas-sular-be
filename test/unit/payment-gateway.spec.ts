import { ConflictException, NotFoundException } from '@nestjs/common';
import { GatewayTransactionStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { PAYMENT_CHANNELS, toPublicChannel } from '../../src/modules/payments/gateway/domain/payment-channel';
import { PaymentProvider } from '../../src/modules/payments/gateway/domain/payment-provider.interface';
import { ManualTransferProvider } from '../../src/modules/payments/gateway/infrastructure/providers/manual-transfer.provider';
import { PaymentChannelRegistry } from '../../src/modules/payments/gateway/payment-channel.registry';
import { PaymentInitiationService } from '../../src/modules/payments/gateway/payment-initiation.service';
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory';

const ACCOUNT = { id: 'acc-1', bankName: 'BCA', bankCode: '014', accountName: 'Mas Sular', accountNumber: '1234567890' };

function manualProvider(overrides: { payment?: unknown; account?: unknown } = {}) {
  const prisma = {
    payment: {
      findUnique: jest.fn().mockResolvedValue(
        overrides.payment === undefined ? { status: PaymentStatus.PENDING, uniqueCode: 321 } : overrides.payment,
      ),
    },
  };
  const accounts = { getActiveAccount: jest.fn().mockResolvedValue(overrides.account ?? ACCOUNT) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { provider: new ManualTransferProvider(prisma as any, accounts as any), prisma, accounts };
}

function registryWith(providers: PaymentProvider[]) {
  const factory = new PaymentProviderFactory(providers);
  return { registry: new PaymentChannelRegistry(factory), factory };
}

describe('payment channel catalog', () => {
  it('exposes every required channel and never leaks a provider name to customers', () => {
    const codes = PAYMENT_CHANNELS.map((c) => c.code);
    expect(codes).toEqual([
      'MANUAL_TRANSFER', 'QRIS', 'GOPAY', 'SHOPEEPAY',
      'BCA_VA', 'BNI_VA', 'BRI_VA', 'MANDIRI_BILL', 'PERMATA_VA', 'CREDIT_CARD',
    ]);
    for (const channel of PAYMENT_CHANNELS) {
      const publicView = JSON.stringify(toPublicChannel(channel)).toLowerCase();
      expect(publicView).not.toContain('midtrans'); // customers must never see the gateway name
      expect(publicView).not.toContain('xendit');
      expect(Object.keys(toPublicChannel(channel))).not.toContain('provider');
    }
  });

  it('binds every channel to a business method the order layer already knows', () => {
    for (const channel of PAYMENT_CHANNELS) {
      expect([PaymentMethod.BANK_TRANSFER, PaymentMethod.GATEWAY]).toContain(channel.method);
    }
    expect(PAYMENT_CHANNELS.find((c) => c.code === 'MANUAL_TRANSFER')?.method).toBe(PaymentMethod.BANK_TRANSFER);
    expect(PAYMENT_CHANNELS.find((c) => c.code === 'QRIS')?.method).toBe(PaymentMethod.GATEWAY);
  });
});

describe('PaymentProviderFactory', () => {
  it('registers providers by name (same contract as ShippingProviderFactory)', () => {
    const { provider } = manualProvider();
    const factory = new PaymentProviderFactory([provider]);
    expect(factory.get('manual')).toBe(provider);
    expect(factory.has('manual')).toBe(true);
    expect(factory.has('midtrans')).toBe(false);
    expect(factory.get('midtrans')).toBeUndefined();
    expect(factory.getAll()).toHaveLength(1);
  });
});

describe('PaymentChannelRegistry', () => {
  it('Phase 1: only manual transfer is available — gateway channels stay hidden', () => {
    const { provider } = manualProvider();
    const { registry } = registryWith([provider]);
    expect(registry.listAvailable().map((c) => c.code)).toEqual(['MANUAL_TRANSFER']);
    expect(registry.list()).toHaveLength(10); // full catalog still visible to diagnostics
  });

  it('provider registration is the live gate: a registered gateway activates its channels', () => {
    // Phase 3: gateway channels are intent-enabled, so a provider that declares
    // support makes them available — this is how MIDTRANS_ENABLED takes effect.
    const fakeMidtrans = {
      name: 'midtrans',
      supportedChannels: () => ['QRIS' as const],
    } as unknown as PaymentProvider;
    const { provider } = manualProvider();
    const { registry } = registryWith([provider, fakeMidtrans]);

    expect(registry.listAvailable().map((c) => c.code)).toEqual(['MANUAL_TRANSFER', 'QRIS']);
    expect(registry.resolve('QRIS').provider.name).toBe('midtrans');
    // A channel whose provider is NOT registered stays unavailable.
    expect(() => registry.resolve('GOPAY')).toThrow(NotFoundException);
  });

  it('the enabled flag remains a per-channel kill switch even when the provider is live', () => {
    const fakeMidtrans = {
      name: 'midtrans',
      supportedChannels: () => ['QRIS' as const],
    } as unknown as PaymentProvider;
    const { provider } = manualProvider();
    const { registry } = registryWith([provider, fakeMidtrans]);

    const disabled = { ...PAYMENT_CHANNELS.find((c) => c.code === 'QRIS')!, enabled: false };
    expect(registry.isAvailable(disabled)).toBe(false);
  });

  it('resolve() returns the live provider for an available channel; 404s otherwise', () => {
    const { provider } = manualProvider();
    const { registry } = registryWith([provider]);
    expect(registry.resolve('MANUAL_TRANSFER').provider).toBe(provider);
    expect(() => registry.resolve('GOPAY')).toThrow(NotFoundException); // enabled=false
    expect(() => registry.resolve('NOPE')).toThrow(NotFoundException); // unknown code
  });

  it('listPublic() is the customer projection (no provider field)', () => {
    const { provider } = manualProvider();
    const { registry } = registryWith([provider]);
    const [channel] = registry.listPublic();
    expect(channel).toMatchObject({ code: 'MANUAL_TRANSFER', label: 'Transfer Bank', method: PaymentMethod.BANK_TRANSFER });
    expect(channel).not.toHaveProperty('provider');
    expect(channel).not.toHaveProperty('enabled');
  });
});

describe('ManualTransferProvider (adapter over the existing flow)', () => {
  const request = {
    paymentId: 'pay-1', orderId: 'o-1', orderNumber: 'BMS-1', amount: 130321,
    channel: 'MANUAL_TRANSFER' as const,
    customer: { name: 'Budi', email: 'b@t.com', phone: null },
  };

  it('describes the transfer WITHOUT writing anything (no behavior change)', async () => {
    const { provider, prisma, accounts } = manualProvider();
    const result = await provider.createCharge(request);

    expect(result).toMatchObject({
      provider: 'manual',
      channel: 'MANUAL_TRANSFER',
      // Phase 2 ledger contract: the payment id is the stable handle for a
      // manual attempt (no external gateway exists to issue one).
      providerReference: 'pay-1',
      providerTransactionId: 'pay-1',
      providerStatus: GatewayTransactionStatus.PENDING,
      status: PaymentStatus.PENDING, // unchanged — checkout already set it
      expiresAt: null, // expiry stays owned by PaymentLifecycleWorker
    });
    expect(result.metadata).toMatchObject({ source: 'manual-transfer', bankName: 'BCA', uniqueCode: 321 });
    expect(result.instructions).toMatchObject({
      kind: 'MANUAL_TRANSFER', amount: 130321, bankName: 'BCA', accountNumber: '1234567890', uniqueCode: 321,
    });
    expect(result.instructions.howTo.join(' ')).toContain('321'); // unique code surfaced
    // Read-only: the only prisma surface touched is findUnique.
    expect(Object.keys(prisma.payment)).toEqual(['findUnique']);
    expect(accounts.getActiveAccount).toHaveBeenCalledTimes(1);
  });

  it('omits the unique-code step when the payment has none (legacy/disabled)', async () => {
    const { provider } = manualProvider({ payment: { status: PaymentStatus.PENDING, uniqueCode: null } });
    const result = await provider.createCharge(request);
    expect(result.instructions.uniqueCode).toBeNull();
    expect(result.instructions.howTo.some((s) => s.includes('kode unik'))).toBe(false);
  });

  it('404s for a missing payment', async () => {
    const { provider } = manualProvider({ payment: null });
    await expect(provider.createCharge(request)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getStatus reads our own row (manual transfer is its own source of truth)', async () => {
    const { provider } = manualProvider({ payment: { status: PaymentStatus.WAITING_VERIFICATION, uniqueCode: 1 } });
    await expect(provider.getStatus({ paymentId: 'pay-1' })).resolves.toMatchObject({
      provider: 'manual', providerReference: null, status: PaymentStatus.WAITING_VERIFICATION,
    });
  });

  it('cancel() refuses to fork the admin-reject / expiry flows, but is a no-op when terminal', async () => {
    const open = manualProvider({ payment: { status: PaymentStatus.PENDING, uniqueCode: 1 } });
    await expect(open.provider.cancel({ paymentId: 'pay-1' })).rejects.toThrow(/admin rejection or automatic expiry/);

    const done = manualProvider({ payment: { status: PaymentStatus.PAID, uniqueCode: 1 } });
    await expect(done.provider.cancel({ paymentId: 'pay-1' })).resolves.toMatchObject({ status: PaymentStatus.PAID });
  });

  it('mapStatus passes through known statuses and defaults unknown ones to PENDING', () => {
    const { provider } = manualProvider();
    expect(provider.mapStatus('PAID')).toBe(PaymentStatus.PAID);
    expect(provider.mapStatus('settlement')).toBe(PaymentStatus.PENDING);
  });
});

describe('PaymentInitiationService (orchestration only)', () => {
  const PAYMENT = {
    id: 'pay-1', orderId: 'o-1', method: PaymentMethod.BANK_TRANSFER, status: PaymentStatus.PENDING, amount: 130321,
    order: { orderNumber: 'BMS-1', user: { name: 'Budi', email: 'b@t.com', phone: '628' } },
  };

  function build(paymentOverrides: Record<string, unknown> = {}) {
    const { provider } = manualProvider();
    const { registry, factory } = registryWith([provider]);
    const prisma = {
      payment: {
        findFirst: jest.fn().mockResolvedValue(
          paymentOverrides === null ? null : { ...PAYMENT, ...paymentOverrides },
        ),
      },
    };
    const ledger = {
      createPendingTransaction: jest.fn().mockResolvedValue({ id: 'gtx-1' }),
      updateGatewayResponse: jest.fn().mockResolvedValue({ id: 'gtx-1' }),
      markFailed: jest.fn().mockResolvedValue({ changed: true }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new PaymentInitiationService(prisma as any, registry, factory, ledger as any);
    return { service, prisma, provider, ledger };
  }

  it('initiate(): resolves the channel and returns the provider result', async () => {
    const { service } = build();
    const result = await service.initiate('pay-1', 'MANUAL_TRANSFER');
    expect(result).toMatchObject({ provider: 'manual', channel: 'MANUAL_TRANSFER' });
  });

  it('initiate(): 409 for a terminal payment — never re-charges a settled order', async () => {
    const { service } = build({ status: PaymentStatus.PAID });
    await expect(service.initiate('pay-1', 'MANUAL_TRANSFER')).rejects.toBeInstanceOf(ConflictException);
  });

  it('initiate(): 409 when the channel method does not match the order method', async () => {
    const { service } = build({ method: PaymentMethod.GATEWAY });
    // MANUAL_TRANSFER is a BANK_TRANSFER channel; the payment is GATEWAY.
    await expect(service.initiate('pay-1', 'MANUAL_TRANSFER')).rejects.toBeInstanceOf(ConflictException);
  });

  it('initiate(): 404 for an unavailable channel (no gateway wired in Phase 1)', async () => {
    const { service } = build();
    await expect(service.initiate('pay-1', 'QRIS')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('initiate(): 404 for a missing payment, before any provider call', async () => {
    const { service, prisma } = build();
    prisma.payment.findFirst.mockResolvedValue(null);
    await expect(service.initiate('pay-x', 'MANUAL_TRANSFER')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refreshStatus(): legacy rows with provider=null are owned by manual', async () => {
    const { service, prisma } = build();
    prisma.payment.findFirst.mockResolvedValue({ id: 'pay-1', provider: null, providerReference: null });
    await expect(service.refreshStatus('pay-1')).resolves.toMatchObject({ provider: 'manual' });
  });

  it('refreshStatus(): 404 when the recorded provider is not registered in this build', async () => {
    const { service, prisma } = build();
    prisma.payment.findFirst.mockResolvedValue({ id: 'pay-1', provider: 'midtrans', providerReference: 'trx-1' });
    await expect(service.refreshStatus('pay-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PaymentGatewayModule wiring (DI graph resolves end to end)', () => {
  const afterAllRestore: Array<() => void> = [];
  afterAll(() => afterAllRestore.forEach((fn) => fn()));

  it('boots, registers exactly one provider, and serves the hardcoded catalog', async () => {
    // Imported lazily so the pure unit tests above stay dependency-free.
    const { Test } = await import('@nestjs/testing');
    const { PaymentGatewayModule } = await import('../../src/modules/payments/gateway/payment-gateway.module');
    const { PrismaService } = await import('../../src/database/prisma.service');
    // DatabaseModule is @Global in the real AppModule; an isolated test module must
    // import it explicitly so PrismaService is resolvable (harness detail, not wiring).
    const { DatabaseModule } = await import('../../src/database/database.module');
    // Likewise MetricsModule: since Phase 5D the gateway module pulls in the shared
    // settlement path, which reaches ShipmentModule and its metrics collectors.
    const { MetricsModule } = await import('../../src/infrastructure/metrics/metrics.module');
    const { PaymentChannelsController } = await import(
      '../../src/modules/payments/gateway/presentation/payment-channels.controller'
    );

    // This case asserts the gateway-DISABLED wiring, so pin the flag rather than
    // inheriting whatever the developer's local .env happens to set.
    const previous = process.env.MIDTRANS_ENABLED;
    process.env.MIDTRANS_ENABLED = 'false';
    afterAllRestore.push(() => { process.env.MIDTRANS_ENABLED = previous; });

    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule, MetricsModule, PaymentGatewayModule] })
      .overrideProvider(PrismaService)
      .useValue({ payment: { findUnique: jest.fn(), findFirst: jest.fn() }, paymentAccount: { findFirst: jest.fn() } })
      .compile();

    const factory = moduleRef.get(PaymentProviderFactory);
    expect(factory.getAll().map((p) => p.name)).toEqual(['manual']); // no gateway wired in Phase 1
    expect(moduleRef.get(PaymentInitiationService)).toBeInstanceOf(PaymentInitiationService);

    const body = moduleRef.get(PaymentChannelsController).list();
    expect(body.channels).toEqual([
      expect.objectContaining({ code: 'MANUAL_TRANSFER', label: 'Transfer Bank', method: PaymentMethod.BANK_TRANSFER }),
    ]);
    expect(JSON.stringify(body).toLowerCase()).not.toContain('midtrans');

    await moduleRef.close();
  });
});
