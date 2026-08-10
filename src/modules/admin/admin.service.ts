import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ShipmentService } from '../shipment/shipment.service';
import { InventoryReservationService } from '../inventory/inventory-reservation.service';
import { CreateBannerDto } from '../cms/application/dto/banner.dto';
import {
  CreateShipmentDto,
  ListAdminOrdersQueryDto,
  ListAdminShipmentsQueryDto,
  RejectAdminPaymentDto,
  UpdateOrderStatusDto,
  UpdateShipmentDto,
  VerifyAdminPaymentDto,
} from './application/dto/admin-operations.dto';
import { OrderCancellationService } from '../orders/order-cancellation.service';
import { orderStatusSourcesFor } from '../orders/domain/order-status-transitions';
import { CreateCategoryDto } from './application/dto/create-category.dto';
import { CreateProductDto } from './application/dto/create-product.dto';
import { CreatePromoDto } from './application/dto/create-promo.dto';
import { CreateRoleDto } from './application/dto/create-role.dto';
import { UpdateBannerDto } from './application/dto/update-banner.dto';
import { UpdateCategoryDto } from './application/dto/update-category.dto';
import { UpdateProductDto } from './application/dto/update-product.dto';
import { UpdatePromoDto } from './application/dto/update-promo.dto';
import { UpdateRoleDto } from './application/dto/update-role.dto';
import { UpdateUserDto } from './application/dto/update-user.dto';
import { pageArgs, paginate } from '../../common/pagination/pagination';
import { buildOrderTimeline, computeAvailableActions } from './order-operations.util';
import { buildOutboxEvent } from '../../infrastructure/outbox/outbox-event.builder';

// Payment terminal states now live with the settlement service (Phase 5D) so that
// admin verification and gateway settlement cannot drift apart. Re-exported here
// only for the reject flow below, which shares the same state machine.
import {
  isTerminalPaymentStatus,
  PaymentSettlementService,
  TERMINAL_PAYMENT_STATUSES,
} from '../payments/settlement/payment-settlement.service';

// Embed region names on address reads so admin Order/Customer/Shipping detail can
// render the full hierarchy. Legacy addresses (null region ids) return null here
// and the UI falls back to `fullAddress`.
const ADDRESS_WITH_REGIONS = {
  include: {
    province: { select: { id: true, code: true, name: true } },
    city: { select: { id: true, code: true, name: true, type: true } },
    district: { select: { id: true, code: true, name: true } },
    village: { select: { id: true, code: true, name: true, postalCode: true } },
  },
} as const;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cancellation: OrderCancellationService,
    // Optional so existing unit tests that construct AdminService with 2 args keep
    // working; when absent, automatic shipment creation is skipped.
    @Optional() private readonly shipments?: ShipmentService,
    // Optional: commits reservations on verify, releases on reject (legacy flow
    // when absent — stock was decremented at checkout).
    @Optional() private readonly inventory?: InventoryReservationService,
    // Phase 5D: the shared settlement path. Optional so the many existing tests that
    // construct AdminService positionally keep working — see `settlement` below.
    @Optional() private readonly injectedSettlement?: PaymentSettlementService,
  ) { }

  private lazySettlement?: PaymentSettlementService;

  /**
   * The shared settlement path. When Nest did not inject one (positional test
   * construction), build it from the collaborators we already hold — the resulting
   * behaviour is identical, because that is exactly what the DI container passes.
   */
  private get settlement(): PaymentSettlementService {
    return (this.injectedSettlement ??
      (this.lazySettlement ??= new PaymentSettlementService(
        this.prisma, this.shipments, this.inventory, this.cancellation,
      )));
  }

  async getDashboard() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const now = new Date();

    const [ordersToday, revenueToday, pendingPayments, activeProducts, lowStockProducts, totalOrders, totalUsers, pendingOrders, verifiedOrders, ordersByStatus, allPromos, totalRedemptions, voucherUsageByVoucher] = await Promise.all([
      this.prisma.order.count({ where: { deletedAt: null, createdAt: { gte: startOfToday } } }),
      this.prisma.order.aggregate({
        where: { deletedAt: null, payment: { status: PaymentStatus.PAID } },
        _sum: { totalPrice: true },
      }),
      this.prisma.payment.count({ where: { deletedAt: null, status: PaymentStatus.WAITING_VERIFICATION } }),
      this.prisma.product.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
      this.prisma.product.count({ where: { deletedAt: null, stock: { lte: 10 } } }),
      this.prisma.order.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.order.count({ where: { deletedAt: null, status: OrderStatus.PENDING } }),
      this.prisma.order.count({ where: { deletedAt: null, status: { in: [OrderStatus.PROCESSING, OrderStatus.DELIVERING, OrderStatus.COMPLETED] } } }),
      this.prisma.order.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { status: true },
      }),
      this.prisma.promo.findMany({ where: { deletedAt: null } }),
      this.prisma.voucherUsage.count(),
      this.prisma.voucherUsage.groupBy({
        by: ['voucherId'],
        _count: { voucherId: true },
        orderBy: { _count: { voucherId: 'desc' } },
        take: 5,
      }),
    ]);

    const validVouchers = allPromos.filter((promo) => {
      if (!promo.isActive) return false;
      if (promo.startDate && promo.startDate > now) return false;
      if (promo.endDate && promo.endDate < now) return false;
      if (promo.maxUsageCount !== null && promo.currentUsageCount >= promo.maxUsageCount) return false;
      return true;
    });

    const topUsedVouchers = await Promise.all(
      voucherUsageByVoucher.map(async (group) => {
        const promo = await this.prisma.promo.findUnique({ where: { id: group.voucherId } });
        return {
          voucherId: group.voucherId,
          code: promo?.code ?? 'unknown',
          title: promo?.title ?? 'Unknown voucher',
          redemptions: group._count.voucherId,
        };
      }),
    );

    return {
      ordersToday,
      totalOrders,
      totalUsers,
      pendingOrders,
      verifiedOrders,
      totalRevenue: revenueToday._sum.totalPrice ?? 0,
      pendingPayments,
      activeProducts,
      lowStockProducts,
      activeVouchers: validVouchers.length,
      expiredVouchers: allPromos.length - validVouchers.length,
      totalVouchers: allPromos.length,
      totalRedemptions,
      topUsedVouchers,
      ordersByStatus: Object.fromEntries(ordersByStatus.map((item) => [item.status, item._count.status])),
    };
  }

  async createProduct(dto: CreateProductDto) {
    return this.prisma.product.create({ data: { ...dto } });
  }

  listProducts() {
    return this.prisma.product.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } });
  }

  async getProduct(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product || product.deletedAt) throw new NotFoundException('Product not found');
    return product;
  }

  async updateProduct(id: string, dto: UpdateProductDto) {
    await this.getProduct(id);
    return this.prisma.product.update({ where: { id }, data: dto });
  }

  async deleteProduct(id: string) {
    await this.getProduct(id);
    return this.prisma.product.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async createCategory(dto: CreateCategoryDto) {
    return this.prisma.category.create({ data: { ...dto } });
  }

  listCategories() {
    return this.prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } });
  }

  async getCategory(id: string) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category || category.deletedAt) throw new NotFoundException('Category not found');
    return category;
  }

  async updateCategory(id: string, dto: UpdateCategoryDto) {
    await this.getCategory(id);
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  async deleteCategory(id: string) {
    await this.getCategory(id);
    return this.prisma.category.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async createPromo(dto: CreatePromoDto) {
    const data = {
      ...dto,
      startDate: dto.startDate ? new Date(dto.startDate) : null,
      endDate: dto.endDate ? new Date(dto.endDate) : null,
    };

    return this.prisma.promo.create({ data });
  }

  listPromos() {
    return this.prisma.promo.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } });
  }

  async getPromo(id: string) {
    const promo = await this.prisma.promo.findUnique({ where: { id } });
    if (!promo || promo.deletedAt) throw new NotFoundException('Promo not found');
    return promo;
  }

  async updatePromo(id: string, dto: UpdatePromoDto) {
    await this.getPromo(id);
    return this.prisma.promo.update({ where: { id }, data: dto });
  }

  async deletePromo(id: string) {
    await this.getPromo(id);
    return this.prisma.promo.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async createBanner(dto: CreateBannerDto) {
    return this.prisma.banner.create({ data: { ...dto } });
  }

  listBanners() {
    return this.prisma.banner.findMany({ where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] });
  }

  async getBanner(id: string) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner || banner.deletedAt) throw new NotFoundException('Banner not found');
    return banner;
  }

  async updateBanner(id: string, dto: UpdateBannerDto) {
    await this.getBanner(id);
    return this.prisma.banner.update({ where: { id }, data: dto });
  }

  async deleteBanner(id: string) {
    await this.getBanner(id);
    return this.prisma.banner.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async listOrders(query: ListAdminOrdersQueryDto) {
    const { skip, take, page, limit } = pageArgs(query);
    const where: Prisma.OrderWhereInput = {
      deletedAt: null,
      status: query.status,
      payment: query.paymentStatus ? { status: query.paymentStatus } : undefined,
    };
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
          address: ADDRESS_WITH_REGIONS,
          items: { include: { toppings: true } },
          payment: true,
          shipment: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginate(items, total, page, limit);
  }

  async getOrder(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        address: ADDRESS_WITH_REGIONS,
        // product image/sku for the operations-center line items (select → no N+1).
        items: { include: { toppings: true, product: { select: { id: true, sku: true, imageUrl: true } } } },
        payment: {
          include: {
            transactions: { orderBy: { createdAt: 'asc' } },
            // Phase 4: latest gateway attempt for the admin read-only panel
            // (provider, provider status, gateway transaction id).
            gatewayTransactions: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
        shipment: { include: { history: { orderBy: { changedAt: 'asc' } } } },
        // Inventory reservations (allocated outlet + reserved qty) for the ops view.
        reservations: {
          include: { outlet: { select: { id: true, name: true } }, product: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
        events: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!order || order.deletedAt) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * Read-only "operations center" bundle: customer lifetime history, unified
   * timeline (order + payment + inventory + shipment), valid quick actions, audit
   * logs, notification history, and the active payment account. One focused
   * findUnique + a parallel Promise.all (no N+1). Never mutates state.
   */
  async getOrderOperations(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
        deletedAt: true,
        createdAt: true,
        payment: {
          select: {
            id: true,
            status: true,
            verifiedAt: true,
            manualReceiptUrl: true,
            createdAt: true,
            transactions: { select: { status: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
          },
        },
        shipment: {
          select: {
            createdAt: true,
            status: true,
            trackingNumber: true,
            trackingUrl: true,
            history: { select: { mappedStatus: true, changedAt: true }, orderBy: { changedAt: 'asc' } },
          },
        },
        events: { select: { status: true, note: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
        reservations: { select: { status: true, createdAt: true, product: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!order || order.deletedAt) throw new NotFoundException('Order not found');
    const paymentId = order.payment?.id;

    const [customerAgg, customerCount, auditLogs, notifications, paymentAccount] = await Promise.all([
      this.prisma.order.aggregate({ where: { userId: order.userId, deletedAt: null, payment: { status: PaymentStatus.PAID } }, _sum: { totalPrice: true } }),
      this.prisma.order.count({ where: { userId: order.userId, deletedAt: null } }),
      this.prisma.auditLog.findMany({
        where: { OR: [{ entity: 'Order', entityId: id }, ...(paymentId ? [{ entity: 'Payment', entityId: paymentId }] : [])] },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, actorId: true, action: true, entity: true, entityId: true, ipAddress: true, after: true, createdAt: true },
      }),
      this.prisma.notificationOutbox.findMany({
        where: { payload: { path: '$.orderId', equals: id } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, channel: true, template: true, status: true, attempts: true, providerMessageId: true, sentAt: true, createdAt: true },
      }),
      this.prisma.paymentAccount.findFirst({ where: { isActive: true }, select: { bankName: true, bankCode: true, accountName: true, accountNumber: true } }),
    ]);

    return {
      customerHistory: { totalOrders: customerCount, lifetimeRevenue: customerAgg._sum.totalPrice ?? 0 },
      timeline: buildOrderTimeline({
        createdAt: order.createdAt,
        events: order.events,
        payment: order.payment
          ? { createdAt: order.payment.createdAt, status: order.payment.status, verifiedAt: order.payment.verifiedAt, transactions: order.payment.transactions }
          : null,
        shipment: order.shipment ? { createdAt: order.shipment.createdAt, history: order.shipment.history } : null,
        reservations: order.reservations,
      }),
      availableActions: computeAvailableActions({
        status: order.status,
        payment: order.payment ? { status: order.payment.status, manualReceiptUrl: order.payment.manualReceiptUrl } : null,
        shipment: order.shipment ? { status: order.shipment.status, trackingNumber: order.shipment.trackingNumber, trackingUrl: order.shipment.trackingUrl } : null,
      }),
      auditLogs,
      notifications,
      paymentAccount,
    };
  }

  async updateOrderStatus(id: string, dto: UpdateOrderStatusDto) {
    const current = await this.getOrder(id);

    // Idempotent no-op: already in the requested status → no event, no outbox.
    if (current.status === dto.status) {
      return this.prisma.order.findUnique({ where: { id }, include: { payment: true, shipment: true } });
    }

    if (dto.status === OrderStatus.CANCELLED) {
      // Cancellation restocks inventory exactly once via the shared transition;
      // order.status_updated is emitted only when this call actually cancels.
      return this.prisma.$transaction(async (tx) => {
        const { cancelled } = await this.cancellation.cancelAndRestock(tx, id, dto.note ?? `Order marked as ${OrderStatus.CANCELLED}`);
        if (cancelled) {
          await tx.outboxEvent.create({
            data: buildOutboxEvent({
              aggregateType: 'order',
              aggregateId: id,
              eventName: 'order.status_updated',
              exchange: 'orders',
              routingKey: 'order.status_updated',
              payload: { orderId: id, status: OrderStatus.CANCELLED },
              metadata: { source: 'admin.updateOrderStatus' },
            }),
          });
        }
        return tx.order.findUnique({ where: { id }, include: { payment: true, shipment: true } });
      }, { timeout: 10000 });
    }

    // Non-CANCELLED transitions: legal-transition CAS (audit F4) — the status only
    // flips when the CURRENT status may legally move to the target (never out of
    // CANCELLED/COMPLETED, never backwards). Status + OrderEvent + outbox commit
    // atomically; a lost CAS (concurrent transition) is a 409, not a silent write.
    return this.prisma.$transaction(async (tx) => {
      const flip = await tx.order.updateMany({
        where: { id, status: { in: orderStatusSourcesFor(dto.status) } },
        data: { status: dto.status },
      });
      if (flip.count !== 1) {
        throw new ConflictException(`Order cannot transition from ${current.status} to ${dto.status}`);
      }
      await tx.orderEvent.create({
        data: { orderId: id, status: dto.status, note: dto.note ?? `Order marked as ${dto.status}` },
      });
      const order = await tx.order.findUniqueOrThrow({
        where: { id },
        include: { payment: true, shipment: true },
      });
      await tx.outboxEvent.create({
        data: buildOutboxEvent({
          aggregateType: 'order',
          aggregateId: order.id,
          eventName: 'order.status_updated',
          exchange: 'orders',
          routingKey: 'order.status_updated',
          payload: { orderId: order.id, status: order.status },
          metadata: { source: 'admin.updateOrderStatus' },
        }),
      });
      return order;
    }, { timeout: 10000 });
  }

  listPayments(status: PaymentStatus = PaymentStatus.WAITING_VERIFICATION, search?: string) {
    const term = search?.trim();
    // A fully-numeric term matches the transfer amount (which already includes the
    // unique code), so finance can paste the incoming amount (e.g. "135123") to find
    // the order. Text terms match order number / customer name / email.
    const amount = term && /^\d+$/.test(term) ? Number(term) : undefined;
    return this.prisma.payment.findMany({
      where: {
        deletedAt: null,
        status,
        ...(term
          ? {
              OR: [
                { order: { orderNumber: { contains: term } } },
                { order: { user: { name: { contains: term } } } },
                { order: { user: { email: { contains: term } } } },
                ...(amount !== undefined ? [{ amount }] : []),
              ],
            }
          : {}),
      },
      include: {
        order: {
          include: {
            user: { select: { id: true, name: true, email: true, phone: true } },
            items: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Admin verification. The transition itself lives in PaymentSettlementService
   * (Phase 5D) so that admin verify and Midtrans settlement share ONE state machine,
   * one inventory commit path, one shipment path and one payment.paid construction.
   * The external contract here — 404, idempotent replay, 409 on a terminal status,
   * and the returned Payment — is unchanged.
   */
  async verifyPayment(paymentId: string, adminId: string, dto: VerifyAdminPaymentDto) {
    const outcome = await this.settlement.settle(paymentId, {
      kind: 'ADMIN',
      adminId,
      note: dto.note ?? null,
    });
    return outcome.payment;
  }

  /**
   * Admin rejection. Like verifyPayment, the transition itself lives in
   * PaymentSettlementService (Phase 5E) so admin, webhook and reconciliation share
   * ONE FAILED path. External contract unchanged: 404, idempotent replay, 409 on a
   * terminal status, and the returned Payment.
   */
  async rejectPayment(paymentId: string, dto: RejectAdminPaymentDto) {
    const outcome = await this.settlement.fail(
      paymentId,
      { kind: 'SYSTEM', source: 'admin.rejectPayment', note: dto.note ?? null },
      dto.note ?? 'Payment rejected by admin',
    );
    return outcome.payment;
  }

  async createShipment(dto: CreateShipmentDto) {
    await this.getOrder(dto.orderId);
    return this.prisma.shipment.create({
      data: {
        orderId: dto.orderId,
        provider: dto.provider,
        service: dto.service,
        cost: dto.cost,
        status: dto.status ?? ShipmentStatus.PENDING,
        trackingNumber: dto.trackingNumber,
        trackingUrl: dto.trackingUrl,
        metadata: dto.metadata as Prisma.InputJsonValue | undefined,
      },
      include: { order: true },
    });
  }

  async listShipments(query: ListAdminShipmentsQueryDto) {
    const { skip, take, page, limit } = pageArgs(query);
    const where: Prisma.ShipmentWhereInput = { status: query.status };
    const [items, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        include: {
          order: {
            include: {
              user: { select: { id: true, name: true, email: true, phone: true } },
              address: ADDRESS_WITH_REGIONS,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.shipment.count({ where }),
    ]);
    return paginate(items, total, page, limit);
  }

  async getShipment(id: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            user: { select: { id: true, name: true, email: true, phone: true } },
            address: ADDRESS_WITH_REGIONS,
          },
        },
      },
    });
    if (!shipment) throw new NotFoundException('Shipment not found');
    return shipment;
  }

  async updateShipment(id: string, dto: UpdateShipmentDto) {
    await this.getShipment(id);
    return this.prisma.shipment.update({
      where: { id },
      data: {
        provider: dto.provider,
        service: dto.service,
        cost: dto.cost,
        status: dto.status,
        trackingNumber: dto.trackingNumber,
        trackingUrl: dto.trackingUrl,
        metadata: dto.metadata as Prisma.InputJsonValue | undefined,
      },
      include: { order: true },
    });
  }

  async deleteShipment(id: string) {
    await this.getShipment(id);
    return this.prisma.shipment.delete({ where: { id } });
  }

  listUsers() {
    return this.prisma.user.findMany({
      where: { deletedAt: null },
      include: { roles: { include: { role: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        roles: { include: { role: true } },
        addresses: ADDRESS_WITH_REGIONS,
        orders: true,
      },
    });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');
    return user;
  }

  async createRole(dto: CreateRoleDto) {
    return this.prisma.role.create({
      data: {
        name: dto.name,
        description: dto.description,
        permissions: dto.permissionIds ? {
          create: dto.permissionIds.map((permissionId) => ({ permissionId })),
        } : undefined,
      },
      include: { permissions: { include: { permission: true } } },
    });
  }

  listRoles() {
    return this.prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async getRole(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: { permissions: { include: { permission: true } } },
    });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  async updateRole(id: string, dto: UpdateRoleDto) {
    await this.getRole(id);

    const updateData: Prisma.RoleUpdateInput = {
      ...(dto.name ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
    };

    if (dto.permissionIds) {
      const [, role] = await this.prisma.$transaction([
        this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
        this.prisma.role.update({
          where: { id },
          data: {
            ...updateData,
            permissions: {
              create: dto.permissionIds.map((permissionId) => ({ permissionId })),
            },
          },
          include: { permissions: { include: { permission: true } } },
        }),
      ]);
      return role;
    }

    return this.prisma.role.update({
      where: { id },
      data: updateData,
      include: { permissions: { include: { permission: true } } },
    });
  }

  async updateUser(id: string, dto: UpdateUserDto) {
    await this.getUser(id);

    const updateData: Prisma.UserUpdateInput = {
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };

    if (dto.roleIds) {
      const [, user] = await this.prisma.$transaction([
        this.prisma.userRole.deleteMany({ where: { userId: id } }),
        this.prisma.user.update({
          where: { id },
          data: {
            ...updateData,
            roles: {
              create: dto.roleIds.map((roleId) => ({ roleId })),
            },
          },
          include: { roles: { include: { role: true } }, addresses: ADDRESS_WITH_REGIONS, orders: true },
        }),
      ]);
      return user;
    }

    return this.prisma.user.update({
      where: { id },
      data: updateData,
      include: { roles: { include: { role: true } }, addresses: ADDRESS_WITH_REGIONS, orders: true },
    });
  }

  listPermissions() {
    return this.prisma.permission.findMany({
      orderBy: { subject: 'asc' },
    });
  }
}
