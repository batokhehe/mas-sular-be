import { OrdersService } from '../../src/modules/orders/orders.service';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';
import { PaymentMethod } from '@prisma/client';

// Base order value = subtotal (20000) + shipping (10000) - discount (0) = 30000.
const USER = 'user-1';
const PRODUCT = { id: 'p1', name: 'Bakso', price: 20000, stock: 10, status: 'ACTIVE', deletedAt: null };
// The mock order.create return value: payment.amount is the transfer total the
// notification sources from (business 30000 + code 321 = 30321).
const CREATED_ORDER = { id: 'order-1', orderNumber: 'BMS-20260704-12345', totalPrice: 30000, items: [], payment: { id: 'pay-1', amount: 30321 } };
const BASE_AMOUNT = 30000;

function dto(over: Partial<CreateOrderDto> = {}): CreateOrderDto {
  return { address_id: 'addr-1', courier: CheckoutCourier.JNE, items: [{ product_id: 'p1', qty: 1 }], ...over };
}

function buildTx() {
  return {
    product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    order: { create: jest.fn().mockResolvedValue(CREATED_ORDER) },
    promo: { update: jest.fn() },
    voucherUsage: { create: jest.fn() },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
}

function buildPrisma(tx = buildTx()) {
  return {
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    address: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'addr-1', userId: USER, deletedAt: null,
        provinceId: 'prov-1', cityId: 'city-1', districtId: 'dist-1', villageId: 'vill-1',
        postalCode: '40131', latitude: -6.9, longitude: 107.6,
      }),
    },
    outlet: { findFirst: jest.fn().mockResolvedValue({ id: 'outlet-1', name: 'Pusat', postalCode: '40111', latitude: -6.9, longitude: 107.6 }) },
    order: { count: jest.fn().mockResolvedValue(0), findUnique: jest.fn() },
    voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
    promo: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
}

/** Build the service with an (optionally enabled) unique-code service in the 8th slot. */
function build(uniqueCode?: { isEnabled: () => boolean; allocateInTx: jest.Mock }, prisma = buildPrisma()) {
  const shipping = { calculateRateForCourier: jest.fn().mockResolvedValue({ cost: 10000, etd: '2 days' }) };
  const idempotency = { isCheckoutEnabled: jest.fn().mockReturnValue(false) };
  const uploadTokens = { issue: jest.fn().mockResolvedValue({ rawToken: 'raw', uploadUrl: 'https://app/payments/upload/raw', expiresAt: new Date() }) };
  const service = new OrdersService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any, shipping as any, idempotency as any, uploadTokens as any,
    undefined, undefined, undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    uniqueCode as any,
  );
  return { service, prisma };
}

function enabledCode(code: number | null) {
  return { isEnabled: () => true, allocateInTx: jest.fn().mockResolvedValue(code) };
}

function orderCreateData(prisma: ReturnType<typeof buildPrisma>) {
  return prisma.__tx.order.create.mock.calls[0][0].data;
}

function outboxPayload(prisma: ReturnType<typeof buildPrisma>) {
  return prisma.__tx.outboxEvent.create.mock.calls[0][0].data.payload;
}

describe('Checkout — BANK_TRANSFER unique code', () => {
  it('generates a unique code and folds it into totalAmount (order + payment)', async () => {
    const uc = enabledCode(123);
    const { service, prisma } = build(uc);
    await service.checkout(USER, dto({ payment_method: PaymentMethod.BANK_TRANSFER }));

    expect(uc.allocateInTx).toHaveBeenCalledWith(expect.anything(), BASE_AMOUNT); // inside the checkout tx
    const data = orderCreateData(prisma);
    // Accounting split: Order.totalPrice is the BUSINESS total (no code)...
    expect(data.totalPrice).toBe(BASE_AMOUNT);
    // ...Payment.amount is the TRANSFER total (business + code)...
    expect(data.payment.create.amount).toBe(BASE_AMOUNT + 123);
    // ...and the code is stored on the payment.
    expect(data.payment.create.uniqueCode).toBe(123);
  });

  it('notifications source the transfer amount from Payment.amount (not Order.totalPrice)', async () => {
    const { service, prisma } = build(enabledCode(321));
    await service.checkout(USER, dto({ payment_method: PaymentMethod.BANK_TRANSFER }));
    // The order.created event carries the transfer total (Payment.amount = 30321),
    // so the (unchanged) notification pipeline still shows the amount to transfer.
    expect(outboxPayload(prisma).totalPrice).toBe(30321);
  });

  it('QRIS has no unique code (amount unchanged, uniqueCode null)', async () => {
    const uc = enabledCode(123);
    const { service, prisma } = build(uc);
    await service.checkout(USER, dto({ payment_method: PaymentMethod.QRIS }));

    expect(uc.allocateInTx).not.toHaveBeenCalled();
    const data = orderCreateData(prisma);
    expect(data.totalPrice).toBe(BASE_AMOUNT);
    expect(data.payment.create.amount).toBe(BASE_AMOUNT);
    expect(data.payment.create.uniqueCode).toBeNull();
  });

  // Phase 4A: COD is no longer selectable, so it never reaches unique-code allocation.
  it('COD is rejected outright — no allocation, no order', async () => {
    const uc = enabledCode(123);
    const { service, prisma } = build(uc);
    await expect(service.checkout(USER, dto({ payment_method: PaymentMethod.COD }))).rejects.toThrow(
      /no longer available/,
    );

    expect(uc.allocateInTx).not.toHaveBeenCalled();
    expect(prisma.__tx.order.create).not.toHaveBeenCalled();
  });

  it('disabled config behaves exactly like the old implementation (no code, amount = base)', async () => {
    const uc = { isEnabled: () => false, allocateInTx: jest.fn() };
    const { service, prisma } = build(uc);
    await service.checkout(USER, dto({ payment_method: PaymentMethod.BANK_TRANSFER }));

    expect(uc.allocateInTx).not.toHaveBeenCalled();
    const data = orderCreateData(prisma);
    expect(data.totalPrice).toBe(BASE_AMOUNT);
    expect(data.payment.create.amount).toBe(BASE_AMOUNT);
    expect(data.payment.create.uniqueCode).toBeNull();
    // Backward compatibility: with no code, Payment.amount == Order.totalPrice.
    expect(data.payment.create.amount).toBe(data.totalPrice);
  });

  it('service absent (legacy wiring): BANK_TRANSFER keeps the base amount, no code', async () => {
    const { service, prisma } = build(undefined);
    await service.checkout(USER, dto({ payment_method: PaymentMethod.BANK_TRANSFER }));
    const data = orderCreateData(prisma);
    expect(data.totalPrice).toBe(BASE_AMOUNT);
    expect(data.payment.create.uniqueCode).toBeNull();
  });
});
