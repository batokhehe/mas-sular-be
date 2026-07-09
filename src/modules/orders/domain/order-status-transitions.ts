import { OrderStatus } from '@prisma/client';

/**
 * Legal order-status transitions (audit F4). Forward-only through the fulfillment
 * flow (skipping intermediate steps is allowed — COD orders are advanced manually),
 * CANCELLED only from active statuses (mirrors OrderCancellationService's CAS
 * whitelist), and nothing ever leaves CANCELLED or COMPLETED. DELIVERED may only
 * COMPLETE. This makes states like CANCELLED → SHIPPED/DELIVERED unrepresentable.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.PROCESSING, OrderStatus.PACKING, OrderStatus.SHIPPED, OrderStatus.DELIVERING, OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.PACKING, OrderStatus.SHIPPED, OrderStatus.DELIVERING, OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.PACKING]: [OrderStatus.SHIPPED, OrderStatus.DELIVERING, OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERING, OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERING]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
};

export function canTransitionOrderStatus(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses allowed to move to `target` — the `IN (...)` list for CAS updates. */
export function orderStatusSourcesFor(target: OrderStatus): OrderStatus[] {
  return (Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[]).filter((from) =>
    ORDER_STATUS_TRANSITIONS[from].includes(target),
  );
}
