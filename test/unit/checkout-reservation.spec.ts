import { OrdersService } from '../../src/modules/orders/orders.service';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';

const USER = 'user-1';
const PRODUCT = { id: 'p1', name: 'Bakso', price: 20000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 250 };
const CREATED_ORDER = { id: 'order-1', orderNumber: 'BMS-1', totalPrice: 30000, items: [], payment: {} };

function dto(over: Partial<CreateOrderDto> = {}): CreateOrderDto {
  return { address_id: 'addr-1', courier: CheckoutCourier.JNE, items: [{ product_id: 'p1', qty: 2 }], ...over };
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

function build(inventory: { reserveForOrder: jest.Mock }) {
  const prisma = buildPrisma();
  const shipping = { calculateRateForCourier: jest.fn().mockResolvedValue({ cost: 10000, etd: '2 days' }) };
  const idempotency = { isCheckoutEnabled: jest.fn().mockReturnValue(false) };
  const uploadTokens = { issue: jest.fn().mockResolvedValue({ uploadUrl: 'https://app/u/x', expiresAt: new Date() }) };
  const service = new OrdersService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any, shipping as any, idempotency as any, uploadTokens as any, undefined, inventory as any,
  );
  return { service, prisma };
}

describe('Checkout — inventory reservation path', () => {
  it('reserves stock (does NOT decrement Product.stock) when inventory is wired', async () => {
    const inventory = { reserveForOrder: jest.fn().mockResolvedValue(undefined) };
    const { service, prisma } = build(inventory);

    await service.checkout(USER, dto());

    expect(inventory.reserveForOrder).toHaveBeenCalledWith(
      prisma.__tx,
      expect.objectContaining({ orderId: 'order-1', items: [{ productId: 'p1', quantity: 2 }] }),
    );
    // Reservation path: no immediate stock decrement.
    expect(prisma.__tx.product.updateMany).not.toHaveBeenCalled();
  });

  it('rolls back the whole checkout when a reservation fails', async () => {
    const inventory = { reserveForOrder: jest.fn().mockRejectedValue(new Error('Insufficient available stock')) };
    const { service } = build(inventory);

    await expect(service.checkout(USER, dto())).rejects.toThrow('Insufficient available stock');
  });
});
