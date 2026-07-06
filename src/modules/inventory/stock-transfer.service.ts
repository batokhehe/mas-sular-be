import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockTransferStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AdjustStockDto, CreateTransferDto, ListInventoryQueryDto, ListTransfersQueryDto } from './application/dto/inventory-admin.dto';
import { pageArgs, paginate } from '../../common/pagination/pagination';

const TRANSFER_INCLUDE = {
  product: { select: { id: true, name: true } },
  fromOutlet: { select: { id: true, name: true } },
  toOutlet: { select: { id: true, name: true } },
} as const;

/**
 * Admin inventory operations: per-outlet stock reads/adjustments and stock
 * transfers between outlets (Requested → Approved → Completed). Every mutation
 * writes an AuditLog. Completion moves ProductInventory.stock atomically.
 */
@Injectable()
export class StockTransferService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------- Product inventory ----------------

  async listInventory(query: ListInventoryQueryDto) {
    const term = query.search?.trim();
    const { skip, take, page, limit } = pageArgs(query);
    const where: Prisma.ProductInventoryWhereInput = {
      productId: query.productId,
      outletId: query.outletId,
      ...(term ? { OR: [{ product: { name: { contains: term } } }, { outlet: { name: { contains: term } } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.productInventory.findMany({
        where,
        include: { product: { select: { id: true, name: true } }, outlet: { select: { id: true, name: true } } },
        orderBy: [{ outletId: 'asc' }, { productId: 'asc' }],
        skip,
        take,
      }),
      this.prisma.productInventory.count({ where }),
    ]);
    return paginate(items, total, page, limit);
  }

  /** Report: totals per outlet (stock / reserved / available) + committed holds. */
  async inventoryReport() {
    const byOutlet = await this.prisma.productInventory.groupBy({
      by: ['outletId'],
      _sum: { stock: true, reserved: true, available: true },
    });
    const committed = await this.prisma.inventoryReservation.groupBy({
      by: ['outletId'],
      where: { status: 'COMMITTED' },
      _sum: { committedQty: true },
    });
    const outlets = await this.prisma.outlet.findMany({ select: { id: true, name: true } });
    const nameById = new Map(outlets.map((o) => [o.id, o.name]));
    const committedById = new Map(committed.map((c) => [c.outletId, c._sum.committedQty ?? 0]));
    return byOutlet.map((row) => ({
      outletId: row.outletId,
      outletName: nameById.get(row.outletId) ?? row.outletId,
      stock: row._sum.stock ?? 0,
      reserved: row._sum.reserved ?? 0,
      available: row._sum.available ?? 0,
      committed: committedById.get(row.outletId) ?? 0,
    }));
  }

  async adjustStock(dto: AdjustStockDto, adminId: string) {
    const existing = await this.prisma.productInventory.findUnique({
      where: { productId_outletId: { productId: dto.productId, outletId: dto.outletId } },
    });
    const reserved = existing?.reserved ?? 0;
    const updated = await this.prisma.productInventory.upsert({
      where: { productId_outletId: { productId: dto.productId, outletId: dto.outletId } },
      update: { stock: dto.stock, available: dto.stock - reserved },
      create: { productId: dto.productId, outletId: dto.outletId, stock: dto.stock, reserved: 0, available: dto.stock },
    });
    await this.audit('inventory.adjust', 'ProductInventory', updated.id, adminId, {
      productId: dto.productId,
      outletId: dto.outletId,
      newStock: dto.stock,
      previousStock: existing?.stock ?? null,
      note: dto.note ?? null,
    });
    return updated;
  }

  // ---------------- Stock transfers ----------------

  async listTransfers(query: ListTransfersQueryDto = {}) {
    const { skip, take, page, limit } = pageArgs(query);
    const where: Prisma.StockTransferWhereInput = { status: query.status };
    const [items, total] = await Promise.all([
      this.prisma.stockTransfer.findMany({
        where,
        include: TRANSFER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);
    return paginate(items, total, page, limit);
  }

  async getTransfer(id: string) {
    const transfer = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: { ...TRANSFER_INCLUDE, history: { orderBy: { createdAt: 'asc' } } },
    });
    if (!transfer) throw new NotFoundException('Transfer not found');
    return transfer;
  }

  async requestTransfer(dto: CreateTransferDto, adminId: string) {
    if (dto.fromOutletId === dto.toOutletId) throw new BadRequestException('Source and destination outlets must differ');
    const transfer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.stockTransfer.create({
        data: { ...dto, status: StockTransferStatus.REQUESTED },
      });
      await tx.stockTransferHistory.create({ data: { transferId: created.id, status: StockTransferStatus.REQUESTED, note: dto.note } });
      return created;
    });
    await this.audit('stockTransfer.request', 'StockTransfer', transfer.id, adminId, { ...dto });
    return this.getTransfer(transfer.id);
  }

  async approveTransfer(id: string, adminId: string) {
    const transfer = await this.getTransfer(id);
    if (transfer.status !== StockTransferStatus.REQUESTED) throw new ConflictException(`Cannot approve a ${transfer.status} transfer`);
    await this.prisma.$transaction(async (tx) => {
      await tx.stockTransfer.update({ where: { id }, data: { status: StockTransferStatus.APPROVED } });
      await tx.stockTransferHistory.create({ data: { transferId: id, status: StockTransferStatus.APPROVED } });
    });
    await this.audit('stockTransfer.approve', 'StockTransfer', id, adminId, {});
    return this.getTransfer(id);
  }

  async completeTransfer(id: string, adminId: string) {
    const transfer = await this.getTransfer(id);
    if (transfer.status !== StockTransferStatus.APPROVED) throw new ConflictException(`Cannot complete a ${transfer.status} transfer`);
    await this.prisma.$transaction(async (tx) => {
      // CAS-claim the transfer: concurrent completions of the SAME transfer can't both
      // move stock — only one flips APPROVED → COMPLETED (the rest get count 0).
      const claim = await tx.stockTransfer.updateMany({
        where: { id, status: StockTransferStatus.APPROVED },
        data: { status: StockTransferStatus.COMPLETED },
      });
      if (claim.count !== 1) throw new ConflictException('Transfer is no longer pending completion');

      // Lock the SOURCE row FOR UPDATE before validating stock, so concurrent
      // transfers draining the same outlet serialize (no oversell / negative stock).
      const locked = await tx.$queryRaw<Array<{ id: string; stock: number; reserved: number }>>(
        Prisma.sql`SELECT id, stock, reserved FROM ProductInventory WHERE productId = ${transfer.productId} AND outletId = ${transfer.fromOutletId} FOR UPDATE`,
      );
      const from = locked[0];
      if (!from || from.stock - from.reserved < transfer.quantity) {
        throw new BadRequestException('Source outlet has insufficient available stock');
      }
      await tx.productInventory.update({
        where: { id: from.id },
        data: { stock: { decrement: transfer.quantity }, available: from.stock - transfer.quantity - from.reserved },
      });
      const to = await tx.productInventory.findUnique({
        where: { productId_outletId: { productId: transfer.productId, outletId: transfer.toOutletId } },
      });
      if (to) {
        await tx.productInventory.update({
          where: { id: to.id },
          data: { stock: { increment: transfer.quantity }, available: to.stock + transfer.quantity - to.reserved },
        });
      } else {
        await tx.productInventory.create({
          data: { productId: transfer.productId, outletId: transfer.toOutletId, stock: transfer.quantity, reserved: 0, available: transfer.quantity },
        });
      }
      await tx.stockTransferHistory.create({ data: { transferId: id, status: StockTransferStatus.COMPLETED } });
    });
    await this.audit('stockTransfer.complete', 'StockTransfer', id, adminId, { quantity: transfer.quantity });
    return this.getTransfer(id);
  }

  private async audit(action: string, entity: string, entityId: string, adminId: string, after: Prisma.InputJsonValue): Promise<void> {
    // actorId NULL: AuditLog.actorId FKs to User; the admin identity is in the payload.
    await this.prisma.auditLog
      .create({ data: { actorId: null, action, entity, entityId, after: { ...(after as object), byAdminId: adminId } } })
      .catch(() => undefined);
  }
}
