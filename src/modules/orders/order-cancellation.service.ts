import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';

/**
 * Single source of truth for cancelling an order and restoring its reserved
 * stock, shared by admin rejection/cancellation and automatic payment expiry.
 * Operates on the caller's transaction so cancellation composes atomically with
 * the payment transition + event that triggered it.
 */
@Injectable()
export class OrderCancellationService {
  /**
   * Cancel an order exactly once. The CANCELLED transition is a CAS over the
   * active-status whitelist, so only the call that actually flips the order
   * restocks inventory and writes the cancellation event. Returns whether this
   * call performed the transition.
   */
  async cancelAndRestock(tx: Prisma.TransactionClient, orderId: string, note: string): Promise<{ cancelled: boolean }> {
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
    await this.restock(tx, orderId);
    await tx.orderEvent.create({ data: { orderId, status: OrderStatus.CANCELLED, note } });
    return { cancelled: true };
  }

  /**
   * Restore inventory for a cancelled order: aggregate item quantities per
   * product and increment product.stock — the exact inverse of the checkout
   * decrement. Products only (toppings are not stock-tracked).
   */
  private async restock(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
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
