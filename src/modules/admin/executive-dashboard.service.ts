import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { num } from '../../common/utils/number.util';

export type HealthLevel = 'green' | 'yellow' | 'red';

const LOW_STOCK_THRESHOLD = 10;
const CACHE_KEY = 'admin:executive-dashboard';
const CACHE_TTL_MS = 30_000;

/** Coerce Prisma raw aggregates (bigint | number | string | null) to a number. */
function toDayKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function pct(current: number, previous: number): { changePct: number; direction: 'up' | 'down' | 'flat' } {
  if (previous === 0) {
    return current === 0 ? { changePct: 0, direction: 'flat' } : { changePct: 100, direction: 'up' };
  }
  const changePct = Math.round(((current - previous) / previous) * 100);
  return { changePct, direction: changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat' };
}

/**
 * Read-only executive dashboard aggregation. One entry point (getDashboard) that
 * fans out every widget query with Promise.all, then caches the whole payload for
 * 30s. Never mutates state; does not touch checkout/payment/inventory/shipment
 * business logic. Separate from AdminService.getDashboard (which is left intact).
 */
@Injectable()
export class ExecutiveDashboardService {
  private readonly logger = new Logger('ExecutiveDashboardService');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Cached (30s) executive dashboard payload. */
  async getDashboard() {
    try {
      const cached = await this.cache.get<Awaited<ReturnType<ExecutiveDashboardService['compute']>>>(CACHE_KEY);
      if (cached) return cached;
    } catch (err) {
      this.logger.warn(`dashboard cache read failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const payload = await this.compute();

    try {
      await this.cache.set(CACHE_KEY, payload, CACHE_TTL_MS);
    } catch {
      // Cache unavailable → serve uncached; never fail the dashboard on cache errors.
    }
    return payload;
  }

  /** Build every widget in parallel (no N+1; aggregates + one bounded findMany each). */
  async compute() {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
    const salesSince = new Date(todayStart.getTime() - 364 * 86_400_000);

    const [
      orderStatus,
      paymentStatus,
      paymentMethod,
      todayRevenue,
      yesterdayRevenue,
      todayOrders,
      yesterdayOrders,
      salesRows,
      topProductRows,
      topCustomerGroups,
      recentOrders,
      lowStock,
      outOfStock,
      reservedAgg,
      needRestock,
      shipmentStatus,
      deliveredToday,
      health,
    ] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      this.prisma.payment.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      this.prisma.payment.groupBy({ by: ['method'], where: { deletedAt: null }, _count: { _all: true } }),
      this.prisma.order.aggregate({ where: { deletedAt: null, payment: { status: PaymentStatus.PAID }, createdAt: { gte: todayStart } }, _sum: { totalPrice: true } }),
      this.prisma.order.aggregate({ where: { deletedAt: null, payment: { status: PaymentStatus.PAID }, createdAt: { gte: yesterdayStart, lt: todayStart } }, _sum: { totalPrice: true } }),
      this.prisma.order.count({ where: { deletedAt: null, createdAt: { gte: todayStart } } }),
      this.prisma.order.count({ where: { deletedAt: null, createdAt: { gte: yesterdayStart, lt: todayStart } } }),
      this.salesRows(salesSince),
      this.topProductRows(),
      this.prisma.order.groupBy({
        by: ['userId'],
        where: { deletedAt: null, payment: { status: PaymentStatus.PAID } },
        _count: { _all: true },
        _sum: { totalPrice: true },
        _max: { createdAt: true },
        orderBy: { _sum: { totalPrice: 'desc' } },
        take: 10,
      }),
      this.prisma.order.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          orderNumber: true,
          totalPrice: true,
          paymentMethod: true,
          status: true,
          user: { select: { name: true } },
          payment: { select: { status: true } },
          shipment: { select: { status: true } },
        },
      }),
      this.prisma.product.count({ where: { deletedAt: null, status: 'ACTIVE', stock: { gt: 0, lte: LOW_STOCK_THRESHOLD } } }),
      this.prisma.product.count({ where: { deletedAt: null, status: 'ACTIVE', stock: { lte: 0 } } }),
      this.prisma.inventoryReservation.aggregate({ where: { status: 'RESERVED' }, _sum: { reservedQty: true } }),
      this.prisma.product.findMany({
        where: { deletedAt: null, status: 'ACTIVE', stock: { lte: LOW_STOCK_THRESHOLD } },
        select: { id: true, name: true, stock: true },
        orderBy: { stock: 'asc' },
        take: 10,
      }),
      this.prisma.shipment.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.shipment.count({ where: { status: ShipmentStatus.DELIVERED, updatedAt: { gte: todayStart } } }),
      this.systemHealth(),
    ]);

    // Resolve the top-customer names in ONE query (no per-row lookup).
    const customerIds = topCustomerGroups.map((g) => g.userId);
    const customers = customerIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true, email: true } })
      : [];
    const customerById = new Map(customers.map((c) => [c.id, c]));

    const orderStatusMap = this.countMap(orderStatus, 'status');
    const paymentStatusMap = this.countMap(paymentStatus, 'status');
    const shipmentStatusMap = this.countMap(shipmentStatus, 'status');

    const todayRev = num(todayRevenue._sum.totalPrice);
    const yRev = num(yesterdayRevenue._sum.totalPrice);
    const revenueDelta = pct(todayRev, yRev);
    const ordersDelta = pct(todayOrders, yesterdayOrders);

    return {
      summary: {
        todayRevenue: { value: todayRev, previous: yRev, ...revenueDelta },
        todayOrders: { value: todayOrders, previous: yesterdayOrders, ...ordersDelta },
        pendingPayments: paymentStatusMap[PaymentStatus.PENDING] ?? 0,
        pendingVerification: paymentStatusMap[PaymentStatus.WAITING_VERIFICATION] ?? 0,
        processing: orderStatusMap[OrderStatus.PROCESSING] ?? 0,
        shipped: orderStatusMap[OrderStatus.SHIPPED] ?? 0,
        delivered: orderStatusMap[OrderStatus.DELIVERED] ?? 0,
        cancelled: orderStatusMap[OrderStatus.CANCELLED] ?? 0,
      },
      // Full 365-day daily series (gap-filled); the client slices 7/30/90/365.
      salesChart: this.fillDailySeries(salesRows, salesSince, now),
      paymentChart: {
        byMethod: this.enumSeries(Object.values(PaymentMethod), paymentMethod, 'method'),
        byStatus: this.enumSeries(Object.values(PaymentStatus), paymentStatus, 'status'),
      },
      topProducts: topProductRows.map((r) => {
        const qtySold = num(r.qtySold);
        const revenue = num(r.revenue);
        return {
          productId: String(r.productId),
          name: String(r.name),
          qtySold,
          revenue,
          avgPrice: qtySold > 0 ? Math.round(revenue / qtySold) : 0,
        };
      }),
      topCustomers: topCustomerGroups.map((g) => ({
        userId: g.userId,
        name: customerById.get(g.userId)?.name ?? 'Unknown',
        email: customerById.get(g.userId)?.email ?? '',
        orders: g._count._all,
        revenue: num(g._sum.totalPrice),
        lastOrder: g._max.createdAt ? g._max.createdAt.toISOString() : null,
      })),
      recentOrders: recentOrders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        customer: o.user?.name ?? '-',
        paymentStatus: o.payment?.status ?? o.paymentMethod,
        orderStatus: o.status,
        shipmentStatus: o.shipment?.status ?? null,
        total: o.totalPrice,
      })),
      inventoryAlert: {
        lowStock,
        outOfStock,
        reserved: num(reservedAgg._sum.reservedQty),
        needRestock: needRestock.map((p) => ({ id: p.id, name: p.name, stock: p.stock })),
      },
      shipmentSummary: {
        waiting:
          (shipmentStatusMap[ShipmentStatus.RATE_SELECTED] ?? 0) +
          (shipmentStatusMap[ShipmentStatus.PENDING] ?? 0) +
          (shipmentStatusMap[ShipmentStatus.CREATED] ?? 0) +
          (shipmentStatusMap[ShipmentStatus.WAITING_PICKUP] ?? 0),
        inTransit:
          (shipmentStatusMap[ShipmentStatus.PICKED_UP] ?? 0) +
          (shipmentStatusMap[ShipmentStatus.IN_TRANSIT] ?? 0) +
          (shipmentStatusMap[ShipmentStatus.OUT_FOR_DELIVERY] ?? 0),
        deliveredToday,
        failed: shipmentStatusMap[ShipmentStatus.FAILED] ?? 0,
      },
      systemHealth: health,
      generatedAt: now.toISOString(),
    };
  }

  // ---------------- Raw aggregates ----------------

  /** Daily orders + PAID revenue for the sales chart (one grouped query). */
  private salesRows(since: Date) {
    return this.prisma.$queryRaw<Array<{ day: unknown; orders: unknown; revenue: unknown }>>(Prisma.sql`
      SELECT DATE(o.createdAt) AS day,
             COUNT(o.id) AS orders,
             COALESCE(SUM(CASE WHEN p.status = 'PAID' THEN o.totalPrice ELSE 0 END), 0) AS revenue
      FROM \`Order\` o
      LEFT JOIN \`Payment\` p ON p.orderId = o.id
      WHERE o.deletedAt IS NULL AND o.createdAt >= ${since}
      GROUP BY DATE(o.createdAt)
      ORDER BY day ASC
    `);
  }

  /** Top 10 products by PAID revenue (qty + revenue in one grouped query). */
  private topProductRows() {
    return this.prisma.$queryRaw<Array<{ productId: unknown; name: unknown; qtySold: unknown; revenue: unknown }>>(Prisma.sql`
      SELECT oi.productId AS productId,
             MAX(oi.productName) AS name,
             SUM(oi.quantity) AS qtySold,
             SUM(oi.unitPrice * oi.quantity) AS revenue
      FROM \`OrderItem\` oi
      JOIN \`Order\` o ON o.id = oi.orderId
      JOIN \`Payment\` p ON p.orderId = o.id
      WHERE o.deletedAt IS NULL AND p.status = 'PAID'
      GROUP BY oi.productId
      ORDER BY revenue DESC
      LIMIT 10
    `);
  }

  // ---------------- System health (real DB/Redis signals) ----------------

  private async systemHealth(): Promise<Record<'database' | 'redis' | 'rabbitmq' | 'worker' | 'notification', HealthLevel>> {
    const [database, redis, outbox, notification] = await Promise.all([
      this.pingDatabase(),
      this.pingRedis(),
      this.outboxBacklogHealth(),
      this.notificationBacklogHealth(),
    ]);

    // The worker (outbox relay) is healthy iff the outbox is draining; RabbitMQ is
    // inferred from the same backlog only when the relay is enabled (else n/a → green).
    const rabbitmq: HealthLevel = process.env.OUTBOX_RELAY_ENABLED === 'true' ? outbox : 'green';
    return { database, redis, rabbitmq, worker: outbox, notification };
  }

  private async pingDatabase(): Promise<HealthLevel> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'green';
    } catch {
      return 'red';
    }
  }

  private async pingRedis(): Promise<HealthLevel> {
    try {
      await this.cache.set('health-check', 'ok', 5_000);
      return (await this.cache.get<string>('health-check')) === 'ok' ? 'green' : 'yellow';
    } catch {
      return 'red';
    }
  }

  private async outboxBacklogHealth(): Promise<HealthLevel> {
    try {
      const rows = await this.prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } });
      return this.backlogLevel(rows);
    } catch {
      return 'red';
    }
  }

  private async notificationBacklogHealth(): Promise<HealthLevel> {
    try {
      const rows = await this.prisma.notificationOutbox.groupBy({ by: ['status'], _count: { _all: true } });
      return this.backlogLevel(rows);
    } catch {
      return 'red';
    }
  }

  /** Green when nothing is stuck, yellow on any FAILED / moderate backlog, red on a large backlog. */
  private backlogLevel(rows: Array<{ status: string; _count: { _all: number } }>): HealthLevel {
    const map = new Map(rows.map((r) => [r.status, r._count._all]));
    const failed = map.get('FAILED') ?? 0;
    const pending = map.get('PENDING') ?? 0;
    if (pending >= 1000 || failed >= 100) return 'red';
    if (failed > 0 || pending >= 100) return 'yellow';
    return 'green';
  }

  // ---------------- Shaping helpers ----------------

  private countMap<K extends string>(rows: Array<Record<K, string> & { _count: { _all: number } }>, key: K): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of rows) out[row[key]] = row._count._all;
    return out;
  }

  private enumSeries<K extends string>(
    keys: string[],
    rows: Array<Record<K, string> & { _count: { _all: number } }>,
    key: K,
  ): Array<{ key: string; count: number }> {
    const map = this.countMap(rows, key);
    return keys.map((k) => ({ key: k, count: map[k] ?? 0 }));
  }

  /** Convert grouped daily rows into a contiguous day-by-day series (zero-filled). */
  private fillDailySeries(
    rows: Array<{ day: unknown; orders: unknown; revenue: unknown }>,
    since: Date,
    now: Date,
  ): Array<{ date: string; revenue: number; orders: number }> {
    const byDay = new Map<string, { revenue: number; orders: number }>();
    for (const r of rows) byDay.set(toDayKey(r.day), { revenue: num(r.revenue), orders: num(r.orders) });

    const series: Array<{ date: string; revenue: number; orders: number }> = [];
    const cursor = new Date(since);
    cursor.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      series.push({ date: key, ...(byDay.get(key) ?? { revenue: 0, orders: 0 }) });
      cursor.setDate(cursor.getDate() + 1);
    }
    return series;
  }
}
