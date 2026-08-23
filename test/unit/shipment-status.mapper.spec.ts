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

  /**
   * CCS is Paxel's cancelled state. This is confirmed behaviour, not an acronym
   * guess: against Paxel staging, POST /shipments/:awb/cancel returned 200
   * echoing the cancellation_reason we sent, after which GET /shipments/:awb
   * reported latest_status "CCS" carrying that same reason.
   *
   * Before this mapping, CCS fell through to UNKNOWN - and the sync service
   * never persists UNKNOWN - so a shipment cancelled at Paxel stayed CREATED in
   * our database indefinitely.
   */
  it('maps Paxel CCS to CANCELLED (confirmed against staging)', () => {
    expect(mapper.map('paxel', 'CCS')).toEqual({ mapped: ShipmentStatus.CANCELLED, known: true });
    expect(mapper.toOrderStatus(mapper.map('paxel', 'CCS').mapped)).toBe(OrderStatus.CANCELLED);
  });

  it('leaves the other undocumented Paxel codes at UNKNOWN', () => {
    const warn = jest.spyOn(mapper['logger'], 'warn').mockImplementation(() => undefined);
    // Still undocumented: guessing a locker state could mark an undelivered
    // parcel as done, or notify a customer early.
    for (const code of ['HAPH', 'FAILED3PL', 'ONHOLD3PL', 'ODL', 'ODLXL', 'POLXL']) {
      expect(mapper.map('paxel', code)).toEqual({ mapped: ShipmentStatus.UNKNOWN, known: false });
    }
    warn.mockRestore();
  });

  it('keeps the previously established Paxel mappings unchanged', () => {
    const expected: Array<[string, ShipmentStatus]> = [
      ['CONFIRMED', ShipmentStatus.CREATED],
      ['RTP', ShipmentStatus.WAITING_PICKUP],
      ['COL', ShipmentStatus.WAITING_PICKUP],
      ['PAPV', ShipmentStatus.PICKED_UP],
      ['POL', ShipmentStatus.IN_TRANSIT],
      ['POD', ShipmentStatus.OUT_FOR_DELIVERY],
      ['COD', ShipmentStatus.OUT_FOR_DELIVERY],
      ['PDO', ShipmentStatus.DELIVERED],
      ['PRJL', ShipmentStatus.FAILED],
      ['RAP', ShipmentStatus.FAILED],
      ['UNDLM', ShipmentStatus.FAILED],
      ['RTN', ShipmentStatus.FAILED],
    ];
    for (const [code, status] of expected) {
      expect(mapper.map('paxel', code)).toEqual({ mapped: status, known: true });
    }
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
