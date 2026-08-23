import { OrdersService } from '../../src/modules/orders/orders.service';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';

/**
 * OrderItem physical snapshot (PAXEL-B2a).
 *
 * Shipment booking happens asynchronously AFTER payment — from the settlement
 * path and again from the reconciliation worker, potentially much later. If the
 * courier request read Product at that moment, an admin editing a product's
 * weight would silently change the parcel of an order that is already paid for.
 *
 * So the physical attributes are snapshotted at order creation, exactly like the
 * productName and unitPrice snapshots that already existed for the same reason.
 * These tests pin that the snapshot is written, that it comes from Product, and
 * that a later Product change cannot reach through to it.
 */

const USER = 'user-1';
const CREATED_ORDER = { id: 'order-1', orderNumber: 'BMS-1', totalPrice: 30000, items: [], payment: {} };

function product(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Bakso',
    price: 20000,
    stock: 10,
    status: 'ACTIVE',
    deletedAt: null,
    weightGram: 450,
    lengthCm: 20,
    widthCm: 15,
    heightCm: 10,
    isFragile: true,
    ...over,
  };
}

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

function build(products: unknown[]) {
  const tx = buildTx();
  const prisma = {
    product: { findMany: jest.fn().mockResolvedValue(products) },
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
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  const shipping = { calculateRateForCourier: jest.fn().mockResolvedValue({ cost: 10000, etd: '2 days' }) };
  const idempotency = { isCheckoutEnabled: jest.fn().mockReturnValue(false) };
  const uploadTokens = { issue: jest.fn().mockResolvedValue({ uploadUrl: 'https://app/u/x', expiresAt: new Date() }) };
  const service = new OrdersService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any, shipping as any, idempotency as any, uploadTokens as any,
  );
  return { service, prisma, tx };
}

/** The OrderItem rows handed to prisma.order.create. */
function createdItems(tx: ReturnType<typeof buildTx>) {
  return tx.order.create.mock.calls[0][0].data.items.create as Array<Record<string, unknown>>;
}

describe('Checkout — OrderItem physical snapshot', () => {
  it('snapshots weight, dimensions and fragility from the product', async () => {
    const { service, tx } = build([product()]);
    await service.checkout(USER, dto());

    expect(createdItems(tx)[0]).toMatchObject({
      productId: 'p1',
      weightGram: 450,
      lengthCm: 20,
      widthCm: 15,
      heightCm: 10,
      isFragile: true,
    });
  });

  it('keeps the existing productName and unitPrice snapshot untouched', async () => {
    const { service, tx } = build([product()]);
    await service.checkout(USER, dto());

    expect(createdItems(tx)[0]).toMatchObject({ productName: 'Bakso', unitPrice: 20000, quantity: 2 });
  });

  it('a later Product edit cannot reach the snapshot — the values are copied, not referenced', async () => {
    const live = product();
    const { service, tx } = build([live]);
    await service.checkout(USER, dto());

    const snapshot = createdItems(tx)[0];
    // Simulate an admin editing the catalogue after the order is placed.
    live.weightGram = 9999;
    live.lengthCm = 49;
    live.isFragile = false;

    expect(snapshot.weightGram).toBe(450);
    expect(snapshot.lengthCm).toBe(20);
    expect(snapshot.isFragile).toBe(true);
  });

  it('carries nulls through for a legacy product with no measurements — never invents them', async () => {
    const legacy = product({ weightGram: null, lengthCm: null, widthCm: null, heightCm: null, isFragile: false });
    const { service, tx } = build([legacy]);
    await service.checkout(USER, dto());

    expect(createdItems(tx)[0]).toMatchObject({
      weightGram: null,
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      isFragile: false,
    });
  });

  it('snapshots per line item, so a mixed cart keeps each product distinct', async () => {
    const a = product();
    const b = product({ id: 'p2', name: 'Mie', weightGram: 120, lengthCm: 10, widthCm: 8, heightCm: 4, isFragile: false });
    const { service, tx } = build([a, b]);
    await service.checkout(USER, dto({ items: [{ product_id: 'p1', qty: 1 }, { product_id: 'p2', qty: 3 }] }));

    const items = createdItems(tx);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.productId === 'p1')).toMatchObject({ weightGram: 450, isFragile: true });
    expect(items.find((i) => i.productId === 'p2')).toMatchObject({ weightGram: 120, isFragile: false, quantity: 3 });
  });

  it('does not change pricing behaviour', async () => {
    const { service, tx } = build([product()]);
    await service.checkout(USER, dto());
    // 2 x 20000 subtotal + 10000 delivery, exactly as before the snapshot existed.
    expect(tx.order.create.mock.calls[0][0].data).toMatchObject({ subtotal: 40000, deliveryFee: 10000 });
  });
});
