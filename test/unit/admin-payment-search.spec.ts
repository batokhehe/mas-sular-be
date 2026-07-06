import { PaymentStatus } from '@prisma/client';
import { AdminService } from '../../src/modules/admin/admin.service';

function svc(rows: unknown[] = []) {
  const payment = { findMany: jest.fn().mockResolvedValue(rows) };
  // AdminService only needs prisma for listPayments; cancellation is unused here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AdminService({ payment } as any, {} as any);
  return { service, payment };
}

describe('AdminService.listPayments — pending verification', () => {
  it('defaults to WAITING_VERIFICATION with no search filter', async () => {
    const { service, payment } = svc();
    await service.listPayments();
    const args = payment.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ deletedAt: null, status: PaymentStatus.WAITING_VERIFICATION });
    expect(args.where.OR).toBeUndefined();
  });

  it('returns payment rows including the unique code (admin page can render it)', async () => {
    const { service } = svc([{ id: 'pay-1', amount: 135123, uniqueCode: 123, method: 'BANK_TRANSFER', order: { orderNumber: 'BMS-1' } }]);
    const rows = await service.listPayments();
    expect(rows[0]).toMatchObject({ uniqueCode: 123, amount: 135123 });
  });

  it('text search matches order number / customer name / email (not amount)', async () => {
    const { service, payment } = svc();
    await service.listPayments(PaymentStatus.WAITING_VERIFICATION, 'jane');
    const or = payment.findMany.mock.calls[0][0].where.OR;
    expect(or).toEqual([
      { order: { orderNumber: { contains: 'jane' } } },
      { order: { user: { name: { contains: 'jane' } } } },
      { order: { user: { email: { contains: 'jane' } } } },
    ]);
  });

  it('numeric search also matches the exact transfer amount (base + unique code)', async () => {
    const { service, payment } = svc();
    await service.listPayments(PaymentStatus.WAITING_VERIFICATION, '135123');
    const or = payment.findMany.mock.calls[0][0].where.OR;
    expect(or).toContainEqual({ amount: 135123 });
  });
});
