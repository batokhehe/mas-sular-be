import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateOrderNoteDto, UpdateOrderNoteDto } from './application/dto/order-note.dto';

/**
 * Admin-only internal order notes (operations annotations). A standalone,
 * additive feature — it never touches the checkout/payment/shipment/inventory/
 * notification flows. A note may only be edited/deleted by its author admin.
 */
@Injectable()
export class AdminOrderNotesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Chronological (newest first) internal notes for an order. */
  async list(orderId: string) {
    await this.assertOrder(orderId);
    return this.prisma.orderNote.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' } });
  }

  async create(orderId: string, admin: { id: string; name: string }, dto: CreateOrderNoteDto) {
    await this.assertOrder(orderId);
    return this.prisma.orderNote.create({
      data: { orderId, adminId: admin.id, adminName: admin.name, body: dto.body.trim() },
    });
  }

  async update(orderId: string, noteId: string, adminId: string, dto: UpdateOrderNoteDto) {
    const note = await this.assertNote(orderId, noteId);
    if (note.adminId !== adminId) throw new ForbiddenException('You can only edit your own notes');
    return this.prisma.orderNote.update({ where: { id: noteId }, data: { body: dto.body.trim() } });
  }

  async remove(orderId: string, noteId: string, adminId: string) {
    const note = await this.assertNote(orderId, noteId);
    if (note.adminId !== adminId) throw new ForbiddenException('You can only delete your own notes');
    await this.prisma.orderNote.delete({ where: { id: noteId } });
    return { deleted: true };
  }

  private async assertOrder(orderId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true } });
    if (!order) throw new NotFoundException('Order not found');
  }

  private async assertNote(orderId: string, noteId: string) {
    const note = await this.prisma.orderNote.findUnique({ where: { id: noteId } });
    if (!note || note.orderId !== orderId) throw new NotFoundException('Note not found');
    return note;
  }
}
