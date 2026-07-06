import { PaymentStatus } from '@prisma/client';
import { AdminService } from '../../src/modules/admin/admin.service';

// Revenue must be the BUSINESS total (Order.totalPrice), which — after the
// accounting split — excludes the manual BANK_TRANSFER unique code. It must never
// be sourced from Payment.amount (the transfer total, code included).
function dashboardPrisma(revenueSum: number) {
  const order = {
    count: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue({ _sum: { totalPrice: revenueSum } }),
    groupBy: jest.fn().mockResolvedValue([]),
  };
  return {
    order,
    payment: { count: jest.fn().mockResolvedValue(0) },
    product: { count: jest.fn().mockResolvedValue(0) },
    user: { count: jest.fn().mockResolvedValue(0) },
    promo: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
    voucherUsage: { count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]) },
  };
}

describe('AdminService.getDashboard — revenue uses Order.totalPrice', () => {
  it('sums Order.totalPrice for PAID orders (business revenue, excludes the unique code)', async () => {
    const prisma = dashboardPrisma(130000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new AdminService(prisma as any, {} as any);

    const dashboard = await service.getDashboard();

    expect(dashboard.totalRevenue).toBe(130000);
    // Revenue is an aggregate over Order.totalPrice, filtered to PAID payments —
    // never Payment.amount.
    expect(prisma.order.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ payment: { status: PaymentStatus.PAID } }),
        _sum: { totalPrice: true },
      }),
    );
  });
});
