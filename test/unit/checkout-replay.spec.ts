import { OrdersService } from '../../src/modules/orders/orders.service';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';

const USER = 'user-1';
const IDEM = { key: 'key-abc', method: 'POST', endpoint: '/checkout/order' };
const DTO: CreateOrderDto = {
  address_id: 'addr-1',
  courier: CheckoutCourier.JNE,
  items: [{ product_id: 'p1', qty: 1 }],
};

// The creation-time response stored on the idempotency row.
const SNAPSHOT = { id: 'order-1', orderNumber: 'BMS-20260612-AB12CD34', status: 'PENDING', payment: { status: 'PENDING' } };
// The current state of the same order at replay time.
const LATEST = { id: 'order-1', orderNumber: 'BMS-20260612-AB12CD34', status: 'PROCESSING', payment: { status: 'PAID' } };

const REPLAY = {
  kind: 'replay' as const,
  statusCode: 201,
  body: SNAPSHOT,
  resourceType: 'Order',
  resourceId: 'order-1',
};

function build(replayMode: 'snapshot' | 'rehydrate', latest: unknown = LATEST) {
  const prisma = { order: { findUnique: jest.fn().mockResolvedValue(latest) } };
  const shipping = {};
  const idempotency = {
    isCheckoutEnabled: jest.fn().mockReturnValue(true),
    retryAfterSeconds: jest.fn().mockReturnValue(2),
    replayMode: jest.fn().mockReturnValue(replayMode),
    begin: jest.fn().mockResolvedValue(REPLAY),
    resolveAfterSupersession: jest.fn(),
  };
  const uploadTokens = { issue: jest.fn() }; // replay paths never create an order
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new OrdersService(prisma as any, shipping as any, idempotency as any, uploadTokens as any);
  return { service, prisma, idempotency };
}

describe('Checkout replay body resolution (A4)', () => {
  it('snapshot mode returns the stored body without re-reading the order', async () => {
    const { service, prisma } = build('snapshot');

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(outcome).toEqual({ kind: 'result', statusCode: 201, replayed: true, body: SNAPSHOT });
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('rehydrate mode returns the latest order (same include as creation)', async () => {
    const { service, prisma } = build('rehydrate');

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(outcome.kind).toBe('result');
    expect((outcome as any).body).toBe(LATEST);
    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      include: { items: { include: { toppings: true } }, payment: true },
    });
  });

  it('rehydrate reflects payment status drift (PENDING snapshot → PAID live)', async () => {
    const { service } = build('rehydrate');
    const outcome = await service.checkout(USER, DTO, IDEM);
    expect((outcome as any).body.payment.status).toBe('PAID');
  });

  it('rehydrate reflects order status drift (PENDING snapshot → PROCESSING live)', async () => {
    const { service } = build('rehydrate');
    const outcome = await service.checkout(USER, DTO, IDEM);
    expect((outcome as any).body.status).toBe('PROCESSING');
  });

  it('rehydrate falls back to the stored snapshot when the order is gone (never 404)', async () => {
    const { service, prisma } = build('rehydrate', null);

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect((outcome as any).body).toBe(SNAPSHOT);
    expect(prisma.order.findUnique).toHaveBeenCalledTimes(1);
  });

  it('rehydrate falls back to snapshot when resourceId is absent', async () => {
    const { service, prisma, idempotency } = build('rehydrate');
    idempotency.begin.mockResolvedValue({ ...REPLAY, resourceId: null });

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect((outcome as any).body).toBe(SNAPSHOT);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });
});
