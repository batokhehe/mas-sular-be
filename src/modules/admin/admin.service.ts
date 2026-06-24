import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma, ShipmentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
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

// Payment terminal states: once a payment reaches any of these it is final and
// no further transition is allowed. PENDING and WAITING_VERIFICATION are the
// only verifiable/rejectable (non-terminal) states.
const TERMINAL_PAYMENT_STATUSES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.FAILED,
  PaymentStatus.EXPIRED,
  PaymentStatus.REFUNDED,
];

function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status);
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cancellation: OrderCancellationService,
  ) { }

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

  listOrders(query: ListAdminOrdersQueryDto) {
    return this.prisma.order.findMany({
      where: {
        deletedAt: null,
        status: query.status,
        payment: query.paymentStatus ? { status: query.paymentStatus } : undefined,
      },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        address: true,
        items: { include: { toppings: true } },
        payment: true,
        shipment: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOrder(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        address: true,
        items: { include: { toppings: true } },
        payment: { include: { transactions: true } },
        shipment: true,
        events: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!order || order.deletedAt) throw new NotFoundException('Order not found');
    return order;
  }

  async updateOrderStatus(id: string, dto: UpdateOrderStatusDto) {
    await this.getOrder(id);

    if (dto.status === OrderStatus.CANCELLED) {
      // Cancellation restocks inventory exactly once via the shared transition;
      // order.status_updated is emitted only when this call actually cancels.
      return this.prisma.$transaction(async (tx) => {
        const { cancelled } = await this.cancellation.cancelAndRestock(tx, id, dto.note ?? `Order marked as ${OrderStatus.CANCELLED}`);
        if (cancelled) {
          await tx.outboxEvent.create({
            data: {
              id: randomUUID(),
              aggregateType: 'order',
              aggregateId: id,
              eventName: 'order.status_updated',
              eventVersion: 1,
              exchange: 'orders',
              routingKey: 'order.status_updated',
              payload: { orderId: id, status: OrderStatus.CANCELLED },
              metadata: { source: 'admin.updateOrderStatus' },
              occurredAt: new Date(),
            },
          });
        }
        return tx.order.findUnique({ where: { id }, include: { payment: true, shipment: true } });
      }, { timeout: 10000 });
    }

    // Non-CANCELLED transitions: status update (+ OrderEvent) and the
    // order.status_updated event commit atomically; outbox is last.
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.update({
        where: { id },
        data: {
          status: dto.status,
          events: { create: { status: dto.status, note: dto.note ?? `Order marked as ${dto.status}` } },
        },
        include: { payment: true, shipment: true },
      });
      await tx.outboxEvent.create({
        data: {
          id: randomUUID(),
          aggregateType: 'order',
          aggregateId: order.id,
          eventName: 'order.status_updated',
          eventVersion: 1,
          exchange: 'orders',
          routingKey: 'order.status_updated',
          payload: { orderId: order.id, status: order.status },
          metadata: { source: 'admin.updateOrderStatus' },
          occurredAt: new Date(),
        },
      });
      return order;
    }, { timeout: 10000 });
  }

  listPayments(status: PaymentStatus = PaymentStatus.WAITING_VERIFICATION) {
    return this.prisma.payment.findMany({
      where: { deletedAt: null, status },
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

  async verifyPayment(paymentId: string, adminId: string, dto: VerifyAdminPaymentDto) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.deletedAt) throw new NotFoundException('Payment not found');

    // Idempotent replay: already in the target terminal state (PAID) → return the
    // current payment with no side effects (no event, audit, or order update).
    if (payment.status === PaymentStatus.PAID) {
      return payment;
    }
    // Any OTHER terminal state (FAILED/EXPIRED/REFUNDED) cannot transition to PAID.
    if (isTerminalPaymentStatus(payment.status)) {
      throw new ConflictException(`Payment cannot be verified from terminal status ${payment.status}`);
    }

    const verifiedAt = new Date();
    // Payment must never become PAID unless the order update, audit record, and
    // outbox event all commit. All four writes run in one interactive transaction.
    return this.prisma.$transaction(async (tx) => {
      // CAS over the non-terminal states. Under a concurrent double-verify only one
      // call flips the row (count === 1); the loser aborts before emitting a second
      // payment.paid — exactly-once event emission.
      const flip = await tx.payment.updateMany({
        where: { id: paymentId, status: { notIn: TERMINAL_PAYMENT_STATUSES } },
        data: { status: PaymentStatus.PAID, verifiedByUserId: adminId, verifiedAt },
      });
      if (flip.count !== 1) {
        throw new ConflictException('Payment already verified or rejected');
      }
      const updated = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      await tx.order.update({
        where: { id: payment.orderId },
        data: {
          status: OrderStatus.PROCESSING,
          events: { create: { status: OrderStatus.PROCESSING, note: dto.note ?? 'Payment verified by admin' } },
        },
      });
      // actorId is NULL: AuditLog.actorId FKs to User, but the verifier is an Admin.
      // The admin identity is recorded in the JSON payload instead.
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'payment.verified',
          entity: 'Payment',
          entityId: updated.id,
          after: { verifiedByAdminId: adminId, status: 'PAID', orderStatus: 'PROCESSING', note: dto.note ?? null },
        },
      });
      await tx.outboxEvent.create({
        data: {
          id: randomUUID(),
          aggregateType: 'payment',
          aggregateId: updated.id,
          eventName: 'payment.paid',
          eventVersion: 1,
          exchange: 'payments',
          routingKey: 'payment.paid',
          payload: {
            paymentId: updated.id,
            orderId: updated.orderId,
            amount: updated.amount,
            status: 'PAID',
            verifiedByUserId: updated.verifiedByUserId,
            verifiedAt: verifiedAt.toISOString(),
            orderStatus: 'PROCESSING',
          },
          metadata: { source: 'admin.verifyPayment' },
          occurredAt: verifiedAt,
        },
      });
      return updated;
    }, { timeout: 10000 });
  }

  async rejectPayment(paymentId: string, dto: RejectAdminPaymentDto) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.deletedAt) throw new NotFoundException('Payment not found');

    // Idempotent replay: already in the target terminal state (FAILED) → return the
    // current payment with no side effects (no restock, event, or order change).
    if (payment.status === PaymentStatus.FAILED) {
      return payment;
    }
    // Any OTHER terminal state (PAID/EXPIRED/REFUNDED) cannot transition to FAILED.
    if (isTerminalPaymentStatus(payment.status)) {
      throw new ConflictException(`Payment cannot be rejected from terminal status ${payment.status}`);
    }

    // Restock + cancellation + payment.failed must commit atomically. The payment
    // FAILED transition is CAS-gated over the non-terminal states, so a concurrent
    // reject flips the row once (count === 1); the loser aborts before emitting a
    // second payment.failed. The order CANCELLED transition is independently CAS-
    // gated, so it never double-restocks.
    return this.prisma.$transaction(async (tx) => {
      const paymentFlip = await tx.payment.updateMany({
        where: { id: paymentId, status: { notIn: TERMINAL_PAYMENT_STATUSES } },
        data: { status: PaymentStatus.FAILED },
      });
      if (paymentFlip.count !== 1) {
        throw new ConflictException('Payment already in a terminal state');
      }

      await this.cancellation.cancelAndRestock(tx, payment.orderId, dto.note ?? 'Payment rejected by admin');

      await tx.outboxEvent.create({
        data: {
          id: randomUUID(),
          aggregateType: 'payment',
          aggregateId: payment.id,
          eventName: 'payment.failed',
          eventVersion: 1,
          exchange: 'payments',
          routingKey: 'payment.failed',
          payload: { paymentId: payment.id, orderId: payment.orderId },
          metadata: { source: 'admin.rejectPayment' },
          occurredAt: new Date(),
        },
      });

      return tx.payment.findUnique({ where: { id: paymentId } });
    }, { timeout: 10000 });
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

  listShipments(query: ListAdminShipmentsQueryDto) {
    return this.prisma.shipment.findMany({
      where: { status: query.status },
      include: { order: { include: { user: { select: { id: true, name: true, email: true, phone: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getShipment(id: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      include: { order: { include: { user: { select: { id: true, name: true, email: true, phone: true } } } } },
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
      include: { roles: { include: { role: true } }, addresses: true, orders: true },
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
          include: { roles: { include: { role: true } }, addresses: true, orders: true },
        }),
      ]);
      return user;
    }

    return this.prisma.user.update({
      where: { id },
      data: updateData,
      include: { roles: { include: { role: true } }, addresses: true, orders: true },
    });
  }

  listPermissions() {
    return this.prisma.permission.findMany({
      orderBy: { subject: 'asc' },
    });
  }
}
