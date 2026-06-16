import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { CheckoutController } from '../../src/modules/orders/presentation/checkout.controller';

const USER = { sub: 'user-1', email: 'u@e.com', roles: ['CUSTOMER'] } as any;
const DTO = { address_id: 'addr-1', courier: 'jne', items: [{ product_id: 'p1', qty: 1 }] } as any;
const RESULT = { kind: 'result', statusCode: 201, replayed: false, body: { id: 'order-1' } };

function buildRes() {
  return { setHeader: jest.fn(), status: jest.fn() };
}

function build(required = false) {
  const orders = { checkout: jest.fn().mockResolvedValue(RESULT) };
  const idempotency = { isCheckoutRequired: jest.fn().mockReturnValue(required) };
  const metrics = {
    missingKey: jest.fn(),
    invalidKey: jest.fn(),
    replay: jest.fn(),
    processingConflict: jest.fn(),
    fingerprintMismatch: jest.fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controller = new CheckoutController(orders as any, idempotency as any, metrics as any);
  return { controller, orders, idempotency, metrics };
}

describe('CheckoutController.createOrder — idempotency enforcement', () => {
  it('missing key + REQUIRED=false → proceeds with no idempotency context', async () => {
    const { controller, orders, metrics } = build(false);
    const res = buildRes();

    const body = await controller.createOrder(USER, DTO, res as any, undefined);

    expect(orders.checkout).toHaveBeenCalledWith('user-1', DTO, undefined);
    expect(metrics.missingKey).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(body).toEqual({ id: 'order-1' });
  });

  it('missing key + REQUIRED=true → 400 before OrdersService', async () => {
    const { controller, orders, metrics } = build(true);
    const res = buildRes();

    await expect(controller.createOrder(USER, DTO, res as any, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(orders.checkout).not.toHaveBeenCalled();
    expect(metrics.missingKey).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty', '', 'empty'],
    ['whitespace-only', '   ', 'empty'],
    ['too long', 'a'.repeat(256), 'too_long'],
    ['invalid charset', 'bad key!', 'charset'],
  ])('invalid key (%s) → 400 without calling OrdersService', async (_label, key, reason) => {
    const { controller, orders, metrics } = build(false);
    const res = buildRes();

    await expect(controller.createOrder(USER, DTO, res as any, key)).rejects.toBeInstanceOf(BadRequestException);
    expect(orders.checkout).not.toHaveBeenCalled();
    expect(metrics.invalidKey).toHaveBeenCalledWith(reason);
  });

  it('valid key → existing behavior (passes idem context, returns body)', async () => {
    const { controller, orders } = build(false);
    const res = buildRes();

    const body = await controller.createOrder(USER, DTO, res as any, 'key-abc_123.4');

    expect(orders.checkout).toHaveBeenCalledWith('user-1', DTO, {
      key: 'key-abc_123.4',
      method: 'POST',
      endpoint: '/checkout/order',
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(body).toEqual({ id: 'order-1' });
  });

  it('replay → 201 + Idempotent-Replayed header + metric', async () => {
    const { controller, orders, metrics } = build(false);
    orders.checkout.mockResolvedValue({ kind: 'result', statusCode: 201, replayed: true, body: { id: 'order-1' } });
    const res = buildRes();

    await controller.createOrder(USER, DTO, res as any, 'key-1');

    expect(res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'true');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(metrics.replay).toHaveBeenCalledTimes(1);
  });

  it('processing → 409 + Retry-After header + metric', async () => {
    const { controller, orders, metrics } = build(false);
    orders.checkout.mockResolvedValue({ kind: 'processing', retryAfterSeconds: 2 });
    const res = buildRes();

    await expect(controller.createOrder(USER, DTO, res as any, 'key-1')).rejects.toBeInstanceOf(ConflictException);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '2');
    expect(metrics.processingConflict).toHaveBeenCalledTimes(1);
  });

  it('fingerprint mismatch (422) → metric emitted and rethrown', async () => {
    const { controller, orders, metrics } = build(false);
    orders.checkout.mockRejectedValue(new UnprocessableEntityException('reused key'));
    const res = buildRes();

    await expect(controller.createOrder(USER, DTO, res as any, 'key-1')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(metrics.fingerprintMismatch).toHaveBeenCalledTimes(1);
  });
});
