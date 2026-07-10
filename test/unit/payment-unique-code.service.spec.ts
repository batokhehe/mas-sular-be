import { ConflictException } from '@nestjs/common';
import { PaymentUniqueCodeService } from '../../src/modules/payments/payment-unique-code.service';
import { loadPaymentUniqueCodeConfig, PaymentUniqueCodeConfig } from '../../src/modules/payments/payment-unique-code.config';

function svc(configOver: Partial<PaymentUniqueCodeConfig> = {}, findFirst = jest.fn().mockResolvedValue(null)) {
  const config: PaymentUniqueCodeConfig = { enabled: true, min: 100, max: 999, maxAttempts: 10, ...configOver };
  const prisma = { payment: { findFirst } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service: new PaymentUniqueCodeService(prisma as any, config), prisma, findFirst };
}

// allocate() was removed in M5 (dead since C4 moved allocation in-tx); the draw
// semantics it covered are asserted here against allocateInTx instead.
describe('PaymentUniqueCodeService', () => {
  const tx = (findFirst: jest.Mock) => ({ payment: { findFirst } }) as never;

  it('returns null and never queries when disabled (legacy behavior)', async () => {
    const { service, findFirst } = svc({ enabled: false });
    await expect(service.allocateInTx(tx(findFirst), 120000)).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
    expect(service.isEnabled()).toBe(false);
  });

  it('generates a random code within [min, max] inclusive', async () => {
    const { service, findFirst } = svc({ min: 100, max: 999 });
    for (let i = 0; i < 50; i += 1) {
      const code = await service.allocateInTx(tx(findFirst), 120000);
      expect(code).not.toBeNull();
      expect(code!).toBeGreaterThanOrEqual(100);
      expect(code!).toBeLessThanOrEqual(999);
      expect(Number.isInteger(code!)).toBe(true);
    }
  });

  it('checks collision only against PENDING BANK_TRANSFER on the final transfer amount', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const { service } = svc({});
    const code = await service.allocateInTx(tx(findFirst), 120000);
    const where = findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ method: 'BANK_TRANSFER', status: 'PENDING', deletedAt: null });
    // The queried amount is the *final* transfer amount (base + code).
    expect(where.amount).toBe(120000 + code!);
  });

  it('retries on collision and returns the first non-colliding code', async () => {
    // First two draws collide, third is free.
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({ id: 'clash-1' })
      .mockResolvedValueOnce({ id: 'clash-2' })
      .mockResolvedValue(null);
    const { service } = svc({ maxAttempts: 10 });
    const code = await service.allocateInTx(tx(findFirst), 120000);
    expect(code).not.toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting attempts when every draw collides (in-tx floor is 10)', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'always-clash' });
    const { service } = svc({ maxAttempts: 5 });
    await expect(service.allocateInTx(tx(findFirst), 120000)).rejects.toBeInstanceOf(ConflictException);
    expect(findFirst).toHaveBeenCalledTimes(10); // Math.max(10, maxAttempts)
  });
});

describe('allocateInTx (C4: in-transaction re-check)', () => {
  it('probes collisions on the CALLER transaction client, not the root client', async () => {
    const { service, findFirst } = svc();
    const txFindFirst = jest.fn().mockResolvedValue(null);
    const tx = { payment: { findFirst: txFindFirst } };

    const code = await service.allocateInTx(tx as never, 120000);

    expect(code).not.toBeNull();
    expect(txFindFirst).toHaveBeenCalled(); // re-check inside the checkout tx
    expect(findFirst).not.toHaveBeenCalled(); // root client untouched
  });

  it('retries on in-tx collision up to 10 attempts, then 409s', async () => {
    const { service } = svc({ maxAttempts: 3 }); // in-tx path still gets >= 10
    const txFindFirst = jest.fn().mockResolvedValue({ id: 'clash' }); // every draw collides
    const tx = { payment: { findFirst: txFindFirst } };

    await expect(service.allocateInTx(tx as never, 120000)).rejects.toBeInstanceOf(ConflictException);
    expect(txFindFirst).toHaveBeenCalledTimes(10);
  });

  it('returns the first non-colliding code after a collision', async () => {
    const { service } = svc();
    const txFindFirst = jest.fn().mockResolvedValueOnce({ id: 'clash' }).mockResolvedValue(null);
    const tx = { payment: { findFirst: txFindFirst } };

    const code = await service.allocateInTx(tx as never, 120000);
    expect(code).toBeGreaterThanOrEqual(100);
    expect(txFindFirst).toHaveBeenCalledTimes(2);
  });

  it('disabled → null without querying', async () => {
    const { service } = svc({ enabled: false });
    const txFindFirst = jest.fn();
    await expect(service.allocateInTx({ payment: { findFirst: txFindFirst } } as never, 1)).resolves.toBeNull();
    expect(txFindFirst).not.toHaveBeenCalled();
  });
});

describe('loadPaymentUniqueCodeConfig', () => {
  it('defaults to disabled with the 100–999 range', () => {
    const cfg = loadPaymentUniqueCodeConfig({});
    expect(cfg).toMatchObject({ enabled: false, min: 100, max: 999 });
  });

  it('parses the enabled flag + range overrides', () => {
    const cfg = loadPaymentUniqueCodeConfig({
      PAYMENT_UNIQUE_CODE_ENABLED: 'true',
      PAYMENT_UNIQUE_CODE_MIN: '200',
      PAYMENT_UNIQUE_CODE_MAX: '800',
    });
    expect(cfg).toMatchObject({ enabled: true, min: 200, max: 800 });
  });

  it('fails fast on invalid ranges (min < 0, max > 999, max <= min)', () => {
    expect(() => loadPaymentUniqueCodeConfig({ PAYMENT_UNIQUE_CODE_MIN: '-1' })).toThrow(/>= 0/);
    expect(() => loadPaymentUniqueCodeConfig({ PAYMENT_UNIQUE_CODE_MAX: '1000' })).toThrow(/<= 999/);
    expect(() => loadPaymentUniqueCodeConfig({ PAYMENT_UNIQUE_CODE_MIN: '500', PAYMENT_UNIQUE_CODE_MAX: '400' })).toThrow(/greater than/);
  });
});
