import { OrdersService } from '../../src/modules/orders/orders.service';
import { SupersededError } from '../../src/infrastructure/idempotency/idempotency.service';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';

const USER = 'user-1';
const IDEM = { key: 'key-abc', method: 'POST', endpoint: '/checkout/order' };

const DTO: CreateOrderDto = {
  address_id: 'addr-1',
  courier: CheckoutCourier.JNE,
  items: [{ product_id: 'p1', qty: 1 }],
};

const PRODUCT = { id: 'p1', name: 'Bakso', price: 20000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 250 };
// payment.amount is the transfer total the order.created event carries (business
// total here since there is no unique code in this suite).
const CREATED_ORDER = { id: 'order-1', orderNumber: 'BMS-20260611-12345', totalPrice: 30000, items: [], payment: { amount: 30000 } };

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
        provinceId: 'prov-1',
        cityId: 'city-1',
        districtId: 'dist-1',
        villageId: 'vill-1',
        postalCode: '40131',
        latitude: -6.9,
        longitude: 107.6,
      }),
    },
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

function buildIdempotency() {
  return {
    isCheckoutEnabled: jest.fn().mockReturnValue(true),
    retryAfterSeconds: jest.fn().mockReturnValue(2),
    replayMode: jest.fn().mockReturnValue('snapshot'),
    begin: jest.fn(),
    finalize: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    resolveAfterSupersession: jest.fn(),
  };
}

const PROCEED = { kind: 'proceed', record: { id: 'rec-1', fenceToken: 1 } };

function build(prisma = buildPrisma(), idempotency = buildIdempotency()) {
  const shipping = { calculateRateForCourier: jest.fn().mockResolvedValue({ cost: 10000, etd: '2 days' }) };
  // Phase 4A: an omitted method now defaults to BANK_TRANSFER, which issues a token.
  const uploadTokens = { issue: jest.fn().mockResolvedValue({ uploadUrl: 'https://app/payments/upload/raw' }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new OrdersService(prisma as any, shipping as any, idempotency as any, uploadTokens as any);
  return { service, prisma, idempotency };
}

describe('Checkout idempotency orchestration', () => {
  it('runs the legacy path when no Idempotency-Key is supplied (emits via outbox)', async () => {
    const { service, prisma, idempotency } = build();

    const outcome = await service.checkout(USER, DTO); // no idem

    expect(idempotency.begin).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.outboxEvent.create).toHaveBeenCalledTimes(1); // order.created via outbox
    expect(outcome).toEqual({ kind: 'result', statusCode: 201, replayed: false, body: CREATED_ORDER });
  });

  it('runs the legacy path when the feature flag is disabled (emits via outbox)', async () => {
    const idempotency = buildIdempotency();
    idempotency.isCheckoutEnabled.mockReturnValue(false);
    const { service, prisma } = build(buildPrisma(), idempotency);

    await service.checkout(USER, DTO, IDEM);

    expect(idempotency.begin).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('fresh key: reserves, creates ONE order, finalizes idempotency in-tx with fenceToken', async () => {
    const prisma = buildPrisma();
    const idempotency = buildIdempotency();
    idempotency.begin.mockResolvedValue(PROCEED);
    const { service } = build(prisma, idempotency);

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.order.create).toHaveBeenCalledTimes(1); // exactly one order
    expect(idempotency.finalize).toHaveBeenCalledWith(
      prisma.__tx,
      'rec-1',
      1, // fenceToken
      expect.objectContaining({ statusCode: 201, resourceType: 'Order', resourceId: 'order-1' }),
    );
    // order.created emitted via the outbox inside the tx.
    expect(prisma.__tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        aggregateType: 'order',
        aggregateId: 'order-1',
        eventName: 'order.created',
        eventVersion: 1,
        exchange: 'orders',
        routingKey: 'order.created',
        // Phase 4A: the default method is BANK_TRANSFER, so a receipt-upload link rides along.
        payload: { orderId: 'order-1', orderNumber: 'BMS-20260611-12345', totalPrice: 30000, uploadUrl: 'https://app/payments/upload/raw' },
      }),
    });
    expect(outcome).toEqual({ kind: 'result', statusCode: 201, replayed: false, body: CREATED_ORDER });
  });

  it('replay: returns the stored response without doing any work or publishing', async () => {
    const prisma = buildPrisma();
    const idempotency = buildIdempotency();
    idempotency.begin.mockResolvedValue({ kind: 'replay', statusCode: 201, body: { id: 'order-1' } });
    const { service } = build(prisma, idempotency);

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(outcome).toEqual({ kind: 'result', statusCode: 201, replayed: true, body: { id: 'order-1' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.__tx.order.create).not.toHaveBeenCalled();
    expect(prisma.__tx.outboxEvent.create).not.toHaveBeenCalled(); // no event on replay
  });

  it('processing: returns a processing outcome carrying Retry-After seconds', async () => {
    const prisma = buildPrisma();
    const idempotency = buildIdempotency();
    idempotency.begin.mockResolvedValue({ kind: 'processing' });
    const { service } = build(prisma, idempotency);

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(outcome).toEqual({ kind: 'processing', retryAfterSeconds: 2 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('marks the key FAILED (with fenceToken) and rethrows when checkout work fails', async () => {
    const prisma = buildPrisma();
    prisma.$transaction.mockRejectedValue(new Error('stock conflict'));
    const idempotency = buildIdempotency();
    idempotency.begin.mockResolvedValue(PROCEED);
    const { service } = build(prisma, idempotency);

    await expect(service.checkout(USER, DTO, IDEM)).rejects.toThrow('stock conflict');
    expect(idempotency.markFailed).toHaveBeenCalledWith('rec-1', 1, expect.any(Error));
  });

  it('superseded → replay: rolls back, never marks FAILED, returns the winner response', async () => {
    const prisma = buildPrisma();
    const idempotency = buildIdempotency();
    idempotency.begin.mockResolvedValue(PROCEED);
    idempotency.finalize.mockRejectedValue(new SupersededError('rec-1', 1)); // reclaimed mid-flight
    idempotency.resolveAfterSupersession.mockResolvedValue({ kind: 'replay', statusCode: 201, body: { id: 'order-1' } });
    const { service } = build(prisma, idempotency);

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(outcome).toEqual({ kind: 'result', statusCode: 201, replayed: true, body: { id: 'order-1' } });
    expect(idempotency.markFailed).not.toHaveBeenCalled(); // we no longer own the key
    expect(prisma.__tx.outboxEvent.create).not.toHaveBeenCalled(); // superseded → no event (rolled back)
  });

  it('superseded → replay rehydrates the latest order (rehydrate mode)', async () => {
    const prisma = buildPrisma();
    const latest = { id: 'order-1', status: 'PROCESSING', payment: { status: 'PAID' } };
    prisma.order.findUnique.mockResolvedValue(latest);
    const idempotency = buildIdempotency();
    idempotency.replayMode.mockReturnValue('rehydrate');
    idempotency.begin.mockResolvedValue(PROCEED);
    idempotency.finalize.mockRejectedValue(new SupersededError('rec-1', 1));
    idempotency.resolveAfterSupersession.mockResolvedValue({
      kind: 'replay',
      statusCode: 201,
      body: { id: 'order-1', status: 'PENDING', payment: { status: 'PENDING' } }, // stale snapshot
      resourceType: 'Order',
      resourceId: 'order-1',
    });
    const { service } = build(prisma, idempotency);

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(outcome).toEqual({ kind: 'result', statusCode: 201, replayed: true, body: latest });
    expect(prisma.order.findUnique).toHaveBeenCalledTimes(1);
  });

  it('superseded → processing: returns 409 outcome, never a raw 500', async () => {
    const prisma = buildPrisma();
    const idempotency = buildIdempotency();
    idempotency.begin.mockResolvedValue(PROCEED);
    idempotency.finalize.mockRejectedValue(new SupersededError('rec-1', 1));
    idempotency.resolveAfterSupersession.mockResolvedValue({ kind: 'processing' });
    const { service } = build(prisma, idempotency);

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(outcome).toEqual({ kind: 'processing', retryAfterSeconds: 2 });
    expect(idempotency.markFailed).not.toHaveBeenCalled();
    expect(prisma.__tx.outboxEvent.create).not.toHaveBeenCalled(); // superseded → no event
  });

  it('concurrency: a second request that resolves to processing creates no order', async () => {
    const prisma = buildPrisma();
    const idempotency = buildIdempotency();
    idempotency.begin
      .mockResolvedValueOnce(PROCEED) // winner
      .mockResolvedValueOnce({ kind: 'processing' }); // concurrent loser
    const { service } = build(prisma, idempotency);

    const first = await service.checkout(USER, DTO, IDEM);
    const second = await service.checkout(USER, DTO, IDEM);

    expect(first.kind).toBe('result');
    expect(second).toEqual({ kind: 'processing', retryAfterSeconds: 2 });
    expect(prisma.__tx.order.create).toHaveBeenCalledTimes(1); // only ONE order across both
  });
});
