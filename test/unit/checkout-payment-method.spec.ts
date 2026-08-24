import { OrdersService } from '../../src/modules/orders/orders.service';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';
import { PaymentMethod } from '@prisma/client';

const USER = 'user-1';
const PRODUCT = { id: 'p1', name: 'Bakso', price: 20000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 250 };
const CREATED_ORDER = { id: 'order-1', orderNumber: 'BMS-20260611-12345', totalPrice: 30000, items: [], payment: {} };

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
        id: 'addr-1',
        userId: USER,
        deletedAt: null,
        // Real destination fields the shipping request validation requires.
        provinceId: 'prov-1',
        cityId: 'city-1',
        districtId: 'dist-1',
        villageId: 'vill-1',
        postalCode: '40131',
        latitude: -6.9,
        longitude: 107.6,
      }),
    },
    // Active outlet (shipping origin) — mocked repository, no placeholders.
    outlet: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'outlet-1',
        name: 'Bakso Mas Sular Pusat',
        postalCode: '40111',
        latitude: -6.9147,
        longitude: 107.6098,
      }),
    },
    order: { count: jest.fn().mockResolvedValue(0), findUnique: jest.fn() },
    voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
    promo: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
}

function build(prisma = buildPrisma()) {
  const shipping = { calculateRateForCourier: jest.fn().mockResolvedValue({ cost: 10000, etd: '2 days' }) };
  const idempotency = { isCheckoutEnabled: jest.fn().mockReturnValue(false) };
  const uploadTokens = {
    issue: jest.fn().mockResolvedValue({ rawToken: 'raw-secret', uploadUrl: 'https://app/payments/upload/raw-secret', expiresAt: new Date() }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new OrdersService(prisma as any, shipping as any, idempotency as any, uploadTokens as any);
  return { service, prisma, uploadTokens };
}

/** Pull the data passed to tx.order.create. */
function orderCreateData(prisma: ReturnType<typeof buildPrisma>) {
  return prisma.__tx.order.create.mock.calls[0][0].data;
}

/** Pull the order.created event payload passed to tx.outboxEvent.create. */
function orderCreatedPayload(prisma: ReturnType<typeof buildPrisma>) {
  return prisma.__tx.outboxEvent.create.mock.calls[0][0].data.payload;
}

describe('Checkout — payment method persistence', () => {
  // Phase 4A: the omitted-method default moved from COD to manual bank transfer.
  it('defaults to BANK_TRANSFER on both Order and Payment when omitted', async () => {
    const { service, prisma } = build();
    await service.checkout(USER, dto());
    const data = orderCreateData(prisma);
    expect(data.paymentMethod).toBe(PaymentMethod.BANK_TRANSFER);
    expect(data.payment.create.method).toBe(PaymentMethod.BANK_TRANSFER);
  });

  it.each([
    PaymentMethod.BANK_TRANSFER,
    PaymentMethod.QRIS,
    PaymentMethod.GATEWAY, // future
  ])('persists the selected method (%s) identically to Order.paymentMethod and Payment.method', async (method) => {
    const { service, prisma } = build();
    await service.checkout(USER, dto({ payment_method: method }));
    const data = orderCreateData(prisma);
    expect(data.paymentMethod).toBe(method);
    expect(data.payment.create.method).toBe(method);
    // The two must never diverge.
    expect(data.payment.create.method).toBe(data.paymentMethod);
  });
});

describe('Checkout — upload token issuance', () => {
  // Phase 4A: COD can no longer be created, so there is no COD token path left.
  it('COD is rejected before any order is written', async () => {
    const { service, prisma, uploadTokens } = build();
    await expect(service.checkout(USER, dto({ payment_method: PaymentMethod.COD }))).rejects.toThrow(
      /no longer available/,
    );
    expect(prisma.__tx.order.create).not.toHaveBeenCalled();
    expect(uploadTokens.issue).not.toHaveBeenCalled();
  });

  it.each([PaymentMethod.BANK_TRANSFER, PaymentMethod.QRIS])(
    '%s: issues a token and includes the uploadUrl in order.created',
    async (method) => {
      const { service, prisma, uploadTokens } = build();
      await service.checkout(USER, dto({ payment_method: method }));
      expect(uploadTokens.issue).toHaveBeenCalledTimes(1);
      expect(orderCreatedPayload(prisma).uploadUrl).toBe('https://app/payments/upload/raw-secret');
    },
  );
});
