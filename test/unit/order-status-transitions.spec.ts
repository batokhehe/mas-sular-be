import { OrderStatus } from '@prisma/client';
import {
  ORDER_STATUS_TRANSITIONS,
  canTransitionOrderStatus,
  orderStatusSourcesFor,
} from '../../src/modules/orders/domain/order-status-transitions';

describe('order status transitions (F4)', () => {
  it('nothing ever leaves CANCELLED or COMPLETED', () => {
    expect(ORDER_STATUS_TRANSITIONS[OrderStatus.CANCELLED]).toEqual([]);
    expect(ORDER_STATUS_TRANSITIONS[OrderStatus.COMPLETED]).toEqual([]);
    for (const target of Object.values(OrderStatus)) {
      expect(canTransitionOrderStatus(OrderStatus.CANCELLED, target)).toBe(false);
      expect(canTransitionOrderStatus(OrderStatus.COMPLETED, target)).toBe(false);
    }
  });

  it('forward flow is allowed (including manual skips); backwards never', () => {
    expect(canTransitionOrderStatus(OrderStatus.PENDING, OrderStatus.PROCESSING)).toBe(true);
    expect(canTransitionOrderStatus(OrderStatus.PENDING, OrderStatus.SHIPPED)).toBe(true); // COD manual skip
    expect(canTransitionOrderStatus(OrderStatus.SHIPPED, OrderStatus.DELIVERED)).toBe(true);
    expect(canTransitionOrderStatus(OrderStatus.DELIVERED, OrderStatus.COMPLETED)).toBe(true);
    // backwards
    expect(canTransitionOrderStatus(OrderStatus.SHIPPED, OrderStatus.PROCESSING)).toBe(false);
    expect(canTransitionOrderStatus(OrderStatus.DELIVERED, OrderStatus.SHIPPED)).toBe(false);
    expect(canTransitionOrderStatus(OrderStatus.PROCESSING, OrderStatus.PENDING)).toBe(false);
  });

  it('CANCELLED is reachable only from active statuses (mirrors the cancellation CAS)', () => {
    expect(orderStatusSourcesFor(OrderStatus.CANCELLED).sort()).toEqual(
      [OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.PACKING, OrderStatus.SHIPPED, OrderStatus.DELIVERING].sort(),
    );
    expect(canTransitionOrderStatus(OrderStatus.DELIVERED, OrderStatus.CANCELLED)).toBe(false);
  });

  it('orderStatusSourcesFor inverts the map (used as the CAS `IN (...)` list)', () => {
    expect(orderStatusSourcesFor(OrderStatus.COMPLETED)).toEqual([OrderStatus.DELIVERED]);
    expect(orderStatusSourcesFor(OrderStatus.PENDING)).toEqual([]); // nothing goes back to PENDING
    expect(orderStatusSourcesFor(OrderStatus.SHIPPED)).not.toContain(OrderStatus.CANCELLED);
  });
});
