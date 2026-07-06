import { AdminService } from '../../src/modules/admin/admin.service';

const ORDER = {
  id: 'o1', userId: 'u1', status: 'PROCESSING', deletedAt: null, createdAt: new Date('2026-07-01T00:00:00Z'),
  payment: {
    id: 'pay1', status: 'WAITING_VERIFICATION', verifiedAt: null, manualReceiptUrl: 'https://f/r.png', createdAt: new Date('2026-07-01T00:00:00Z'),
    transactions: [{ status: 'WAITING_VERIFICATION', createdAt: new Date('2026-07-01T01:00:00Z') }],
  },
  shipment: { createdAt: new Date('2026-07-01T03:00:00Z'), status: 'FAILED', trackingNumber: null, trackingUrl: null, history: [] },
  events: [{ status: 'PENDING', note: 'Order created', createdAt: new Date('2026-07-01T00:00:00Z') }],
  reservations: [{ status: 'RESERVED', createdAt: new Date('2026-07-01T00:01:00Z'), product: { name: 'Bakso' } }],
};

const AUDIT = [{ id: 'a1', actorId: null, action: 'payment.verified', entity: 'Payment', entityId: 'pay1', ipAddress: '1.2.3.4', after: { verifiedByAdminId: 'admin1' }, createdAt: new Date() }];
const NOTIFS = [{ id: 'n1', channel: 'WHATSAPP', template: 'order.transfer', status: 'SENT', attempts: 1, providerMessageId: 'q1', sentAt: new Date(), createdAt: new Date() }];

function svc() {
  const prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue(ORDER),
      aggregate: jest.fn().mockResolvedValue({ _sum: { totalPrice: 900000 } }),
      count: jest.fn().mockResolvedValue(7),
    },
    auditLog: { findMany: jest.fn().mockResolvedValue(AUDIT) },
    notificationOutbox: { findMany: jest.fn().mockResolvedValue(NOTIFS) },
    paymentAccount: { findFirst: jest.fn().mockResolvedValue({ bankName: 'BCA', bankCode: '014', accountName: 'Toko', accountNumber: '123' }) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service: new AdminService(prisma as any, {} as any), prisma };
}

describe('AdminService.getOrderOperations', () => {
  it('returns customer lifetime history', async () => {
    const { service } = svc();
    const ops = await service.getOrderOperations('o1');
    expect(ops.customerHistory).toEqual({ totalOrders: 7, lifetimeRevenue: 900000 });
  });

  it('passes through audit history and notification history', async () => {
    const { service, prisma } = svc();
    const ops = await service.getOrderOperations('o1');
    // Audit filter covers both the order and its payment.
    const auditWhere = prisma.auditLog.findMany.mock.calls[0][0].where;
    expect(auditWhere.OR).toEqual(expect.arrayContaining([{ entity: 'Order', entityId: 'o1' }, { entity: 'Payment', entityId: 'pay1' }]));
    expect(ops.auditLogs).toEqual(AUDIT);
    // Notifications filtered by the order id embedded in the JSON payload.
    expect(prisma.notificationOutbox.findMany.mock.calls[0][0].where).toEqual({ payload: { path: '$.orderId', equals: 'o1' } });
    expect(ops.notifications).toEqual(NOTIFS);
  });

  it('builds a merged timeline and computes valid quick actions for the current state', async () => {
    const { service } = svc();
    const ops = await service.getOrderOperations('o1');
    expect(ops.timeline.map((t) => t.type)).toEqual([
      'order.created', 'payment.created', 'inventory.reserved', 'payment.uploaded',
    ]);
    // WAITING_VERIFICATION payment + FAILED shipment + PROCESSING order + receipt present.
    expect(ops.availableActions).toEqual({
      verifyPayment: true, rejectPayment: true, retryShipment: true, cancelOrder: true, downloadReceipt: true, openTracking: false,
    });
  });

  it('404s for a missing/deleted order', async () => {
    const { service, prisma } = svc();
    prisma.order.findUnique.mockResolvedValueOnce(null);
    await expect(service.getOrderOperations('missing')).rejects.toThrow('Order not found');
  });
});
