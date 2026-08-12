import { GatewayTransactionStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { OrdersService } from '../../src/modules/orders/orders.service';

/**
 * Phase 5J.8 — the order list carries the latest gateway attempt's DEADLINE.
 *
 * `Payment.status` stays PENDING until the provider's expire notification lands,
 * which can lag by hours, so the storefront cannot tell a live QRIS attempt from
 * a dead one. Exposing `expiryAt` lets it stop offering "Bayar Sekarang" for an
 * attempt that already expired.
 *
 * This is a LIST endpoint, so anything selected here is repeated for every order:
 * the QR payload, VA number, provider ids, raw provider bodies and the provider
 * NAME must never appear. Those assertions are the point of this spec.
 */

const EXPIRY = new Date('2026-08-12T08:47:35.000Z');

/** Only the fields the narrow `select` is allowed to return. */
const attempt = (over: Record<string, unknown> = {}) => ({
  expiryAt: EXPIRY,
  status: GatewayTransactionStatus.PENDING,
  ...over,
});

function service(orders: unknown[]) {
  const prisma = { order: { findMany: jest.fn().mockResolvedValue(orders) } };
  // Only listForUser is exercised; every other collaborator is optional and unused.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new OrdersService(prisma as any, undefined as any, undefined as any, undefined as any);
  return { svc, prisma };
}

const gatewayOrder = (over: Record<string, unknown> = {}) => ({
  id: 'o-1',
  orderNumber: 'BMS-20260812-KAJ5A65C',
  paymentMethod: PaymentMethod.GATEWAY,
  items: [],
  address: {},
  shipment: null,
  payment: {
    id: 'pay-1',
    orderId: 'o-1',
    method: PaymentMethod.GATEWAY,
    status: PaymentStatus.PENDING,
    amount: 210000,
    gatewayTransactions: [attempt()],
  },
  ...over,
});

describe('listForUser exposes the latest gateway attempt', () => {
  it('surfaces expiryAt + status as payment.gateway', async () => {
    const { svc } = service([gatewayOrder()]);
    const [order] = await svc.listForUser('user-1');

    expect(order.payment!.gateway).toEqual({ expiryAt: EXPIRY, status: GatewayTransactionStatus.PENDING });
  });

  it('keeps every existing Payment field it returned before', async () => {
    const { svc } = service([gatewayOrder()]);
    const [order] = await svc.listForUser('user-1');

    expect(order.payment).toMatchObject({
      id: 'pay-1', orderId: 'o-1', method: PaymentMethod.GATEWAY,
      status: PaymentStatus.PENDING, amount: 210000,
    });
    // The relation name is an internal detail and must not leak.
    expect(order.payment).not.toHaveProperty('gatewayTransactions');
  });

  it('asks Prisma for exactly ONE attempt, newest first, with a narrow select', async () => {
    const { svc, prisma } = service([gatewayOrder()]);
    await svc.listForUser('user-1');

    const args = prisma.order.findMany.mock.calls[0][0];
    expect(args.include.payment.include.gatewayTransactions).toEqual({
      orderBy: { createdAt: 'desc' }, // index-backed by @@index([paymentId, createdAt])
      take: 1,
      select: { expiryAt: true, status: true },
    });
  });

  it('selects the NEWEST attempt when several exist', async () => {
    // Prisma applies orderBy+take, so the first row IS the newest; assert we read
    // that one rather than the last.
    const newest = attempt({ expiryAt: new Date('2026-08-12T09:00:00.000Z') });
    const { svc } = service([
      gatewayOrder({
        payment: { ...gatewayOrder().payment, gatewayTransactions: [newest, attempt()] },
      }),
    ]);

    const [order] = await svc.listForUser('user-1');
    expect(order.payment!.gateway!.expiryAt).toEqual(new Date('2026-08-12T09:00:00.000Z'));
  });
});

describe('nothing sensitive reaches the order list', () => {
  it('never exposes provider payload, ids, or the provider NAME', async () => {
    // Even if the ledger row carried them, the select must keep them out. This
    // simulates a widened select regressing the contract.
    const leaky = {
      ...attempt(),
      qrString: 'QRIS-PAYLOAD',
      vaNumber: '8778000000000000',
      redirectUrl: 'https://redirect',
      deeplinkUrl: 'gojek://pay',
      providerOrderId: 'BMS-20260812-KAJ5A65C-ca35b81c',
      providerReference: 'ref-1',
      providerTransactionId: 'trx-1',
      rawRequest: { secret: 'x' },
      rawResponse: { secret: 'y' },
      metadata: { secret: 'z' },
      failureReason: 'nope',
      provider: 'midtrans',
    };
    const { svc } = service([
      gatewayOrder({ payment: { ...gatewayOrder().payment, gatewayTransactions: [leaky] } }),
    ]);

    const [order] = await svc.listForUser('user-1');
    const keys = Object.keys(order.payment!.gateway!);
    expect(keys.sort()).toEqual(['expiryAt', 'status']);

    const serialized = JSON.stringify(order);
    for (const secret of ['QRIS-PAYLOAD', '8778000000000000', 'ca35b81c', 'midtrans', 'gojek://pay']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('manual and un-initiated payments are unaffected', () => {
  it('manual BANK_TRANSFER yields gateway: null and keeps its fields', async () => {
    const manual = gatewayOrder({
      paymentMethod: PaymentMethod.BANK_TRANSFER,
      payment: {
        id: 'pay-2', orderId: 'o-1', method: PaymentMethod.BANK_TRANSFER,
        status: PaymentStatus.WAITING_VERIFICATION, amount: 130321, uniqueCode: 321,
        manualReceiptUrl: '/uploads/r.png', gatewayTransactions: [],
      },
    });
    const { svc } = service([manual]);
    const [order] = await svc.listForUser('user-1');

    expect(order.payment!.gateway).toBeNull();
    expect(order.payment).toMatchObject({ uniqueCode: 321, manualReceiptUrl: '/uploads/r.png' });
  });

  it('a GATEWAY payment whose charge never opened yields gateway: null', async () => {
    const { svc } = service([
      gatewayOrder({ payment: { ...gatewayOrder().payment, gatewayTransactions: [] } }),
    ]);
    const [order] = await svc.listForUser('user-1');
    expect(order.payment!.gateway).toBeNull();
  });

  it('an order with no payment row at all does not crash', async () => {
    const { svc } = service([gatewayOrder({ payment: null })]);
    await expect(svc.listForUser('user-1')).resolves.toEqual([expect.objectContaining({ payment: null })]);
  });
});

describe('the existing query contract is preserved', () => {
  it('keeps ownership, soft-delete, status filter, includes and ordering', async () => {
    const { svc, prisma } = service([]);
    await svc.listForUser('user-1', 'PROCESSING');

    const args = prisma.order.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 'user-1', deletedAt: null, status: 'PROCESSING' });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.include.items).toEqual({ include: { toppings: true } });
    expect(args.include.address).toBe(true);
    expect(args.include.shipment).toBe(true);
  });

  it('scopes to the requested user only', async () => {
    const { svc, prisma } = service([]);
    await svc.listForUser('user-2');
    expect(prisma.order.findMany.mock.calls[0][0].where.userId).toBe('user-2');
  });
});
