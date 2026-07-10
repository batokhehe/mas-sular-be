import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaymentMethod, Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ListReservationsQueryDto } from './application/dto/inventory-reservation-query.dto';
import { pageArgs, paginate } from '../../common/pagination/pagination';
import { positiveInt } from '../../common/utils/number.util';

const ADMIN_INCLUDE = {
  order: { select: { id: true, orderNumber: true, user: { select: { id: true, name: true, email: true } } } },
  product: { select: { id: true, name: true } },
  outlet: { select: { id: true, name: true } },
} as const;

export interface ReservationItem {
  productId: string;
  quantity: number;
}

export interface ReserveArgs {
  orderId: string;
  items: ReservationItem[];
  paymentMethod: PaymentMethod;
  /** Allocated outlet (multi-outlet). When set, stock is tracked per-outlet in
   *  ProductInventory; otherwise the legacy Product.stock path is used. */
  outletId?: string | null;
}

/**
 * Stock reservation ledger. Available stock = Product.stock − active RESERVED qty.
 * Reservations are created at checkout (no stock change), COMMITTED at payment
 * verification (deducts Product.stock), and RELEASED/EXPIRED on cancel/expiry.
 * Product.stock stays the source of truth.
 */
@Injectable()
export class InventoryReservationService {
  private readonly logger = new Logger('InventoryReservationService');

  constructor(private readonly prisma: PrismaService) {}

  /** Reservation expiry = payment expiry window (null for methods that never expire). */
  reservationExpiry(method: PaymentMethod, from = new Date()): Date | null {
    if (method === PaymentMethod.BANK_TRANSFER || method === PaymentMethod.QRIS) {
      return new Date(from.getTime() + positiveInt(process.env.PAYMENT_EXPIRY_MS, 24 * 60 * 60 * 1000));
    }
    if (method === PaymentMethod.GATEWAY) {
      const ms = positiveInt(process.env.PAYMENT_GATEWAY_EXPIRY_MS, 0);
      return ms > 0 ? new Date(from.getTime() + ms) : null;
    }
    return null; // COD never expires
  }

  /** Non-locking available-stock read for previews. */
  async availableFor(productId: string): Promise<number> {
    const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { stock: true } });
    if (!product) return 0;
    const reserved = await this.prisma.inventoryReservation.aggregate({
      where: { productId, status: ReservationStatus.RESERVED },
      _sum: { reservedQty: true },
    });
    return product.stock - (reserved._sum.reservedQty ?? 0);
  }

  /**
   * Reserve stock for every order item in the caller's transaction. Each product
   * row is locked FOR UPDATE so concurrent checkouts serialize (no overselling);
   * insufficient available stock throws, rolling back the whole checkout.
   */
  async reserveForOrder(tx: Prisma.TransactionClient, args: ReserveArgs): Promise<void> {
    const expiresAt = this.reservationExpiry(args.paymentMethod);
    const legacyOutletId = args.outletId
      ? null
      : (await tx.outlet.findFirst({ where: { isActive: true }, select: { id: true } }))?.id ?? null;

    const qtyByProduct = new Map<string, number>();
    for (const item of args.items) {
      qtyByProduct.set(item.productId, (qtyByProduct.get(item.productId) ?? 0) + item.quantity);
    }

    // Deterministic lock order (ascending productId): every checkout acquires its
    // FOR UPDATE locks in the same sequence regardless of cart item order, so two
    // carts with the same products in reversed order can never deadlock (H1).
    const orderedProducts = [...qtyByProduct.entries()].sort(([a], [b]) => a.localeCompare(b));

    for (const [productId, quantity] of orderedProducts) {
      // Multi-outlet path: per-outlet ProductInventory (when an outlet is allocated
      // AND a ProductInventory row exists). Otherwise the legacy Product.stock path.
      const pi = args.outletId
        ? await tx.productInventory.findUnique({ where: { productId_outletId: { productId, outletId: args.outletId } } })
        : null;

      if (args.outletId && pi) {
        const rows = await tx.$queryRaw<Array<{ stock: number; reserved: number }>>(
          Prisma.sql`SELECT stock, reserved FROM ProductInventory WHERE id = ${pi.id} FOR UPDATE`,
        );
        const row = rows[0];
        const available = (row?.stock ?? 0) - (row?.reserved ?? 0);
        if (available < quantity) throw new BadRequestException('Insufficient available stock');

        await tx.productInventory.update({
          where: { id: pi.id },
          data: { reserved: { increment: quantity }, available: (row!.stock - row!.reserved) - quantity },
        });
        const reservation = await tx.inventoryReservation.create({
          data: { orderId: args.orderId, productId, outletId: args.outletId, reservedQty: quantity, status: ReservationStatus.RESERVED, expiresAt },
        });
        await this.addHistory(tx, reservation.id, ReservationStatus.RESERVED, 'Reservation created');
        continue;
      }

      // Legacy Product.stock path (backward compatible).
      const rows = await tx.$queryRaw<Array<{ stock: number }>>(
        Prisma.sql`SELECT stock FROM Product WHERE id = ${productId} FOR UPDATE`,
      );
      const stock = rows[0]?.stock;
      if (stock === undefined) throw new BadRequestException('Product is unavailable');

      const reserved = await tx.inventoryReservation.aggregate({
        where: { productId, status: ReservationStatus.RESERVED },
        _sum: { reservedQty: true },
      });
      if (stock - (reserved._sum.reservedQty ?? 0) < quantity) throw new BadRequestException('Insufficient available stock');

      const reservation = await tx.inventoryReservation.create({
        data: { orderId: args.orderId, productId, outletId: args.outletId ?? legacyOutletId, reservedQty: quantity, status: ReservationStatus.RESERVED, expiresAt },
      });
      await this.addHistory(tx, reservation.id, ReservationStatus.RESERVED, 'Reservation created');
    }
  }

  /**
   * Commit every RESERVED reservation for an order: deduct Product.stock by
   * reservedQty and mark COMMITTED. Called after payment is verified.
   *
   * C2: the RESERVED → COMMITTED transition is a per-row CAS. A reservation the
   * expiry worker flipped to EXPIRED between our snapshot read and this write
   * loses the CAS and is SKIPPED — never resurrected, never double-counted.
   */
  async commitForOrder(tx: Prisma.TransactionClient, orderId: string, note = 'Committed on payment verified'): Promise<number> {
    const reservations = await tx.inventoryReservation.findMany({
      where: { orderId, status: ReservationStatus.RESERVED },
    });
    let committed = 0;
    for (const r of reservations) {
      const flip = await tx.inventoryReservation.updateMany({
        where: { id: r.id, status: ReservationStatus.RESERVED },
        data: { status: ReservationStatus.COMMITTED, committedQty: r.reservedQty },
      });
      if (flip.count !== 1) {
        this.logger.warn(`reservation ${r.id} left RESERVED before commit (expired concurrently) — skipped`);
        continue; // stock/hold already handled by whoever won the transition
      }

      const pi = await this.lockedPiFor(tx, r.productId, r.outletId);
      if (pi) {
        // Multi-outlet: deduct outlet stock and release the hold. `available` is
        // recomputed from the FOR UPDATE row (C5): (stock−q) − (reserved−q).
        await tx.productInventory.update({
          where: { id: pi.id },
          data: { stock: { decrement: r.reservedQty }, reserved: { decrement: r.reservedQty }, available: pi.stock - pi.reserved },
        });
      } else {
        await tx.product.update({ where: { id: r.productId }, data: { stock: { decrement: r.reservedQty } } });
      }
      await this.addHistory(tx, r.id, ReservationStatus.COMMITTED, note);
      committed += 1;
    }
    return committed;
  }

  /**
   * Per-outlet inventory row locked FOR UPDATE (C5) — mirrors reserveForOrder's
   * locking so `available` is always recomputed from current, serialized values
   * (never a stale snapshot). Null → legacy Product.stock path.
   */
  private async lockedPiFor(
    tx: Prisma.TransactionClient,
    productId: string,
    outletId: string | null,
  ): Promise<{ id: string; stock: number; reserved: number } | null> {
    if (!outletId) return null;
    const pi = await tx.productInventory.findUnique({
      where: { productId_outletId: { productId, outletId } },
      select: { id: true },
    });
    if (!pi) return null;
    const rows = await tx.$queryRaw<Array<{ id: string; stock: number; reserved: number }>>(
      Prisma.sql`SELECT id, stock, reserved FROM ProductInventory WHERE id = ${pi.id} FOR UPDATE`,
    );
    return rows[0] ?? null;
  }

  /**
   * Release active reservations for an order. COMMITTED reservations restock
   * Product.stock (it was deducted at commit); RESERVED ones just free the hold.
   * Returns whether any reservation existed (so legacy orders fall back to the
   * old restock path).
   */
  async releaseForOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
    status: ReservationStatus = ReservationStatus.RELEASED,
    note = 'Reservation released',
  ): Promise<{ handled: boolean }> {
    const reservations = await tx.inventoryReservation.findMany({
      where: { orderId, status: { in: [ReservationStatus.RESERVED, ReservationStatus.COMMITTED] } },
    });
    for (const r of reservations) {
      const releasedQty = r.status === ReservationStatus.COMMITTED ? r.committedQty : r.reservedQty;
      // CAS on the OBSERVED status (C2-style): if the expiry worker (or a
      // concurrent commit) transitioned this row after our snapshot read, skip it
      // — the winner already adjusted stock/hold, touching counters again would
      // corrupt them.
      const flip = await tx.inventoryReservation.updateMany({
        where: { id: r.id, status: r.status },
        data: { status, releasedQty },
      });
      if (flip.count !== 1) {
        this.logger.warn(`reservation ${r.id} changed state before release — skipped`);
        continue;
      }

      const pi = await this.lockedPiFor(tx, r.productId, r.outletId);
      if (pi) {
        // Multi-outlet: COMMITTED → restock outlet; RESERVED → free the hold.
        // `available` recomputed from the FOR UPDATE row (C5).
        if (r.status === ReservationStatus.COMMITTED && r.committedQty > 0) {
          await tx.productInventory.update({
            where: { id: pi.id },
            data: { stock: { increment: r.committedQty }, available: pi.stock + r.committedQty - pi.reserved },
          });
        } else {
          await tx.productInventory.update({
            where: { id: pi.id },
            data: { reserved: { decrement: r.reservedQty }, available: pi.stock - (pi.reserved - r.reservedQty) },
          });
        }
      } else if (r.status === ReservationStatus.COMMITTED && r.committedQty > 0) {
        await tx.product.update({ where: { id: r.productId }, data: { stock: { increment: r.committedQty } } });
      }
      await this.addHistory(tx, r.id, status, note);
    }
    return { handled: reservations.length > 0 };
  }

  /** Worker: CAS-expire a single RESERVED reservation (concurrency-safe). */
  async expireReservation(id: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const flip = await tx.inventoryReservation.updateMany({
        where: { id, status: ReservationStatus.RESERVED },
        data: { status: ReservationStatus.EXPIRED },
      });
      if (flip.count !== 1) return false;

      const row = await tx.inventoryReservation.findUnique({
        where: { id },
        select: { reservedQty: true, productId: true, outletId: true },
      });
      const reservedQty = row?.reservedQty ?? 0;

      // Release the per-outlet hold so ProductInventory.available recovers. A
      // RESERVED reservation never deducted stock, so only `reserved` is freed
      // (stock unchanged). Legacy reservations without a ProductInventory row never
      // touched per-outlet inventory → nothing to release (backward compatible).
      // Row locked FOR UPDATE (C5) so `available` is recomputed from current values.
      const pi = await this.lockedPiFor(tx, row?.productId ?? '', row?.outletId ?? null);
      if (pi) {
        await tx.productInventory.update({
          where: { id: pi.id },
          data: { reserved: { decrement: reservedQty }, available: pi.stock - (pi.reserved - reservedQty) },
        });
      }

      await tx.inventoryReservation.update({ where: { id }, data: { releasedQty: reservedQty } });
      await this.addHistory(tx, id, ReservationStatus.EXPIRED, 'Expired by reservation worker');
      return true;
    });
  }

  private async addHistory(
    tx: Prisma.TransactionClient,
    reservationId: string,
    status: ReservationStatus,
    note?: string,
  ): Promise<void> {
    await tx.inventoryReservationHistory.create({ data: { reservationId, status, note } });
  }

  // ---------------- Admin reads ----------------

  async listReservations(query: ListReservationsQueryDto) {
    const term = query.search?.trim();
    const { skip, take, page, limit } = pageArgs(query);
    const where: Prisma.InventoryReservationWhereInput = {
      status: query.status,
      outletId: query.outletId,
      ...(query.expired ? { expiresAt: { not: null, lte: new Date() } } : {}),
      ...(term
        ? {
            OR: [
              { order: { orderNumber: { contains: term } } },
              { product: { name: { contains: term } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.inventoryReservation.findMany({
        where,
        include: ADMIN_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.inventoryReservation.count({ where }),
    ]);
    return paginate(items, total, page, limit);
  }

  async getReservation(id: string) {
    const reservation = await this.prisma.inventoryReservation.findUnique({
      where: { id },
      include: { ...ADMIN_INCLUDE, history: { orderBy: { createdAt: 'asc' } } },
    });
    if (!reservation) throw new NotFoundException('Reservation not found');
    return reservation;
  }
}
