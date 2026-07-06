import { OrderStatus, ShipmentStatus } from '@prisma/client';
import { ShipmentStatusMapper } from '../../src/modules/shipment/shipment-status.mapper';

describe('ShipmentStatusMapper', () => {
  const mapper = new ShipmentStatusMapper();

  it('maps Paxel statuses to internal statuses', () => {
    expect(mapper.map('paxel', 'BOOKED')).toEqual({ mapped: ShipmentStatus.CREATED, known: true });
    expect(mapper.map('paxel', 'OUT_FOR_DELIVERY').mapped).toBe(ShipmentStatus.OUT_FOR_DELIVERY);
    expect(mapper.map('paxel', 'DELIVERED').mapped).toBe(ShipmentStatus.DELIVERED);
    expect(mapper.map('paxel', 'CANCELLED').mapped).toBe(ShipmentStatus.CANCELLED);
  });

  it('maps JNE statuses (with spaces/case) to internal statuses', () => {
    expect(mapper.map('jne', 'on process').mapped).toBe(ShipmentStatus.IN_TRANSIT);
    expect(mapper.map('jne', 'With Delivery Courier').mapped).toBe(ShipmentStatus.OUT_FOR_DELIVERY);
    expect(mapper.map('jne', 'DELIVERED').mapped).toBe(ShipmentStatus.DELIVERED);
  });

  it('returns UNKNOWN (and logs) for unrecognized statuses', () => {
    const warn = jest.spyOn(mapper['logger'], 'warn').mockImplementation(() => undefined);
    const result = mapper.map('jne', 'SOMETHING_WEIRD');
    expect(result).toEqual({ mapped: ShipmentStatus.UNKNOWN, known: false });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('derives the order status and notify flag from the mapped status', () => {
    expect(mapper.toOrderStatus(ShipmentStatus.IN_TRANSIT)).toBe(OrderStatus.DELIVERING);
    expect(mapper.toOrderStatus(ShipmentStatus.DELIVERED)).toBe(OrderStatus.DELIVERED);
    expect(mapper.toOrderStatus(ShipmentStatus.CANCELLED)).toBe(OrderStatus.CANCELLED);
    expect(mapper.toOrderStatus(ShipmentStatus.FAILED)).toBeNull();
    expect(mapper.shouldNotify(ShipmentStatus.PICKED_UP)).toBe(true);
    expect(mapper.shouldNotify(ShipmentStatus.WAITING_PICKUP)).toBe(false);
  });
});
