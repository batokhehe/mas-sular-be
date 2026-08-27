import { ShipmentStatus, OrderStatus } from '@prisma/client';
import { ShipmentService } from '../../src/modules/shipment/shipment.service';

/**
 * PAXELBOX-19: the customer-facing shipment notifications used to read
 * `Shipment.service` raw. That field is a snapshot — checkout writes the display
 * LABEL into it, and nothing keeps it in step with the order — so a customer
 * could be told a service their order was not booked with.
 *
 * The authority is the order: the label it was quoted
 * (`Order.shippingServiceName`), then the paid code (`Order.shippingService`),
 * and only then the shipment's own value, which is what keeps HISTORICAL rows
 * rendering without a migration. This is the precedence the order.shipped
 * notification already used; these tests extend it to order.delivered.
 */

function shipmentRow(over: {
  shipmentService?: string;
  shippingServiceName?: string | null;
  shippingService?: string | null;
}) {
  return {
    id: 'sh1',
    provider: 'paxel',
    service: over.shipmentService ?? 'Paxel Same Day',
    status: ShipmentStatus.OUT_FOR_DELIVERY,
    trackingNumber: 'AWB-1',
    metadata: null,
    order: {
      id: 'o1',
      orderNumber: 'BMS-1',
      status: OrderStatus.SHIPPED,
      shippingServiceName: over.shippingServiceName ?? null,
      shippingService: over.shippingService ?? null,
      user: { name: 'Budi', email: 'budi@test.com', phone: '628123' },
      address: { phone: '628123' },
    },
  };
}

function build(row: ReturnType<typeof shipmentRow>) {
  const tx = {
    shipment: { update: jest.fn().mockResolvedValue({}) },
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    shipment: { findMany: jest.fn().mockResolvedValue([row]) },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  const provider = {
    name: 'paxel',
    trackShipment: jest.fn().mockResolvedValue({ status: ShipmentStatus.DELIVERED, history: [] }),
  };
  const service = new ShipmentService(prisma as never, { get: () => provider } as never);
  return { service, tx };
}

/** The service string put on the outgoing delivered notification. */
function notifiedService(tx: ReturnType<typeof build>['tx']): string | undefined {
  const call = tx.notificationOutbox.create.mock.calls.find(
    (c) => c[0]?.data?.template === 'order.delivered',
  );
  return call?.[0]?.data?.payload?.shippingService;
}

describe('order.delivered tells the customer the service they paid for', () => {
  it('uses the quoted label over the shipment snapshot', async () => {
    const { service, tx } = build(
      shipmentRow({
        shipmentService: 'Paxel Same Day',
        shippingServiceName: 'Paxel Instant',
        shippingService: 'PAXEL_INSTANT',
      }),
    );

    await service.pollAndUpdate();

    expect(notifiedService(tx)).toBe('Paxel Instant');
  });

  it('falls back to the paid code when no label was stored', async () => {
    const { service, tx } = build(
      shipmentRow({ shipmentService: 'Paxel Same Day', shippingServiceName: null, shippingService: 'PAXEL_INSTANT' }),
    );

    await service.pollAndUpdate();

    expect(notifiedService(tx)).toBe('PAXEL_INSTANT');
  });

  it('a stale shipment snapshot never reaches the customer', async () => {
    const { service, tx } = build(
      shipmentRow({ shipmentService: 'PAXEL_NEXTDAY', shippingServiceName: null, shippingService: 'PAXEL_INSTANT' }),
    );

    await service.pollAndUpdate();

    expect(notifiedService(tx)).toBe('PAXEL_INSTANT');
    expect(notifiedService(tx)).not.toBe('PAXEL_NEXTDAY');
  });

  it('a legacy row with no order service still notifies, unmigrated', async () => {
    const { service, tx } = build(
      shipmentRow({ shipmentService: 'JNE Reguler (Mock)', shippingServiceName: null, shippingService: null }),
    );

    await service.pollAndUpdate();

    expect(notifiedService(tx)).toBe('JNE Reguler (Mock)');
  });
});
