import { Injectable, Optional } from '@nestjs/common';
import { OrderStatus, Prisma, ReservationStatus } from '@prisma/client';
import { InventoryReservationService } from '../inventory/inventory-reservation.service';

/**
 * Single source of truth for cancelling an order and restoring its reserved
 * stock, shared by admin rejection/cancellation and automatic payment expiry.
 * Operates on the caller's transaction so cancellation composes atomically with
 * the payment transition + event that triggered it.
 */
@Injectable()
export class OrderCancellationService {
  // Optional: when present, cancellation RELEASES/EXPIRES reservations (restocking
  // only the committed portion). Absent (legacy/tests) → old item-based restock.
  constructor(@Optional() private readonly inventory?: InventoryReservationService) {}

  /**
   * Cancel an order exactly once. The CANCELLED transition is a CAS over the
   * active-status whitelist, so only the call that actually flips the order
   * restocks inventory and writes the cancellation event. Returns whether this
   * call performed the transition. `releaseStatus` controls the reservation
   * terminal state (RELEASED for cancel/reject, EXPIRED for payment expiry).
   */
  async cancelAndRestock(
    tx: Prisma.TransactionClient,
    orderId: string,
    note: string,
    releaseStatus: ReservationStatus = ReservationStatus.RELEASED,
  ): Promise<{ cancelled: boolean }> {
    const flip = await tx.order.updateMany({
      where: {
        id: orderId,
        deletedAt: null,
        // Cancellable while active (pre-delivery); DELIVERED/COMPLETED are terminal.
        status: {
          in: [
            OrderStatus.PENDING,
            OrderStatus.PROCESSING,
            OrderStatus.PACKING,
            OrderStatus.SHIPPED,
            OrderStatus.DELIVERING,
          ],
        },
      },
      data: { status: OrderStatus.CANCELLED },
    });
    if (flip.count !== 1) {
      return { cancelled: false };
    }
    await this.restock(tx, orderId, note, releaseStatus);
    await tx.orderEvent.create({ data: { orderId, status: OrderStatus.CANCELLED, note } });
    return { cancelled: true };
  }

  /**
   * Restore inventory for a cancelled order. With reservations (new model): release
   * them — COMMITTED reservations restock (stock was deducted at commit), RESERVED
   * ones just free the hold. Without reservations (legacy orders / no inventory
   * service): increment product.stock from order items (inverse of the old
   * checkout decrement).
   */
  private async restock(
    tx: Prisma.TransactionClient,
    orderId: string,
    note: string,
    releaseStatus: ReservationStatus,
  ): Promise<void> {
    if (this.inventory) {
      await this.inventory.releaseForOrder(tx, orderId, releaseStatus, note);
      // The legacy fallback below is ONLY for pre-reservation orders (their stock
      // was decremented at checkout). A reservation-era order whose reservations
      // are already terminal (e.g. expired by the reservation worker before this
      // cancellation) must NOT fall through — RESERVED never deducted stock, so
      // the fallback increment would inflate inventory (audit F2).
      const reservationRows = await tx.inventoryReservation.count({ where: { orderId } });
      if (reservationRows > 0) return;
    }
    // Legacy fallback (pre-reservation orders only).
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { productId: true, quantity: true } });
    const quantityByProduct = new Map<string, number>();
    for (const item of items) {
      quantityByProduct.set(item.productId, (quantityByProduct.get(item.productId) ?? 0) + item.quantity);
    }
    for (const [productId, quantity] of quantityByProduct) {
      await tx.product.updateMany({ where: { id: productId }, data: { stock: { increment: quantity } } });
    }
  }
}
