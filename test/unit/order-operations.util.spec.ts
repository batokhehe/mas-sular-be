import { buildOrderTimeline, computeAvailableActions, TimelineSource } from '../../src/modules/admin/order-operations.util';

const T0 = new Date('2026-07-01T00:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('buildOrderTimeline', () => {
  it('merges order/payment/inventory/shipment into one ascending timeline', () => {
    const src: TimelineSource = {
      createdAt: T0,
      events: [{ status: 'PENDING', note: 'Order created', createdAt: T0 }],
      payment: {
        createdAt: T0,
        status: 'PAID',
        verifiedAt: at(2 * 3600_000),
        transactions: [{ status: 'WAITING_VERIFICATION', createdAt: at(3600_000) }],
      },
      shipment: {
        createdAt: at(3 * 3600_000),
        history: [
          { mappedStatus: 'CREATED', changedAt: at(3 * 3600_000) },
          { mappedStatus: 'IN_TRANSIT', changedAt: at(5 * 3600_000) },
          { mappedStatus: 'DELIVERED', changedAt: at(8 * 3600_000) },
        ],
      },
      reservations: [{ status: 'RESERVED', createdAt: at(60_000), product: { name: 'Bakso' } }],
    };

    const types = buildOrderTimeline(src).map((e) => e.type);
    expect(types).toEqual([
      'order.created',
      'payment.created',
      'inventory.reserved',
      'payment.uploaded',
      'payment.verified',
      'shipment.created',
      'shipment.in_transit',
      'shipment.delivered',
    ]);
  });

  it('is sorted strictly by timestamp regardless of source ordering', () => {
    const src: TimelineSource = {
      createdAt: T0,
      events: [{ status: 'CANCELLED', note: 'Rejected by admin', createdAt: at(4 * 3600_000) }],
      payment: { createdAt: T0, status: 'FAILED', verifiedAt: null, transactions: [] },
      shipment: null,
      reservations: [],
    };
    const timeline = buildOrderTimeline(src);
    const ts = timeline.map((e) => new Date(e.at).getTime());
    expect([...ts]).toEqual([...ts].sort((a, b) => a - b));
    expect(timeline.some((e) => e.type === 'order.cancelled' && e.actor === 'admin')).toBe(true);
  });

  it('omits payment-verified when the payment is not PAID', () => {
    const src: TimelineSource = {
      createdAt: T0,
      events: [],
      payment: { createdAt: T0, status: 'WAITING_VERIFICATION', verifiedAt: null, transactions: [{ status: 'WAITING_VERIFICATION', createdAt: at(60_000) }] },
      shipment: null,
      reservations: [],
    };
    const types = buildOrderTimeline(src).map((e) => e.type);
    expect(types).toContain('payment.uploaded');
    expect(types).not.toContain('payment.verified');
  });
});

describe('computeAvailableActions (quick action visibility)', () => {
  const base = { status: 'PROCESSING', payment: null, shipment: null };

  it('verify/reject only while the payment is PENDING or WAITING_VERIFICATION', () => {
    expect(computeAvailableActions({ ...base, payment: { status: 'WAITING_VERIFICATION', manualReceiptUrl: null } }))
      .toMatchObject({ verifyPayment: true, rejectPayment: true });
    expect(computeAvailableActions({ ...base, payment: { status: 'PAID', manualReceiptUrl: null } }))
      .toMatchObject({ verifyPayment: false, rejectPayment: false });
  });

  it('retryShipment only for FAILED, or untracked RATE_SELECTED/PENDING', () => {
    expect(computeAvailableActions({ ...base, shipment: { status: 'FAILED', trackingNumber: null, trackingUrl: null } }).retryShipment).toBe(true);
    expect(computeAvailableActions({ ...base, shipment: { status: 'RATE_SELECTED', trackingNumber: null, trackingUrl: null } }).retryShipment).toBe(true);
    expect(computeAvailableActions({ ...base, shipment: { status: 'DELIVERED', trackingNumber: 'JNE1', trackingUrl: null } }).retryShipment).toBe(false);
  });

  it('cancelOrder only for pre-shipment statuses', () => {
    expect(computeAvailableActions({ ...base, status: 'PROCESSING' }).cancelOrder).toBe(true);
    expect(computeAvailableActions({ ...base, status: 'DELIVERED' }).cancelOrder).toBe(false);
    expect(computeAvailableActions({ ...base, status: 'SHIPPED' }).cancelOrder).toBe(false);
  });

  it('downloadReceipt/openTracking gated on the presence of the receipt / tracking', () => {
    expect(computeAvailableActions({ ...base, payment: { status: 'PAID', manualReceiptUrl: 'https://f/r.png' } }).downloadReceipt).toBe(true);
    expect(computeAvailableActions({ ...base, shipment: { status: 'IN_TRANSIT', trackingNumber: 'JNE1', trackingUrl: null } }).openTracking).toBe(true);
    expect(computeAvailableActions(base).openTracking).toBe(false);
  });
});
