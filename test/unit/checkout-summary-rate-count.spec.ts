import { OrdersService } from '../../src/modules/orders/orders.service';
import { ShippingService } from '../../src/modules/shipping/shipping.service';

/**
 * Call-count proof for the getSummary quote reuse.
 *
 * This wires a REAL ShippingService to a fake courier that fans out to four
 * services the way PaxelProvider.getRates() does, and counts each one. No
 * network: the point is the number of provider round-trips a summary costs.
 *
 * Before the fix a summary cost 8 (allocation 4 + findQuote re-quote 4).
 */

const USER = 'user-1';
const PRODUCT = { id: 'p1', name: 'Keju', price: 45000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 200 };
const PAXEL_SERVICES = ['PAXEL_INSTANT', 'PAXEL_SAMEDAY', 'PAXEL_NEXTDAY', 'PAXEL_REGULAR'];

const OUTLET = {
  id: 'outlet-1',
  name: 'Pusat',
  postalCode: '40111',
  latitude: -6.9147,
  longitude: 107.6098,
  addressDetail: 'Jl. Outlet No.1',
  province: { name: 'Jawa Barat' },
  city: { name: 'Kota Bandung' },
  district: { name: 'Coblong' },
  village: { name: 'Dago' },
};

const ADDRESS = {
  id: 'addr-1',
  userId: USER,
  deletedAt: null,
  provinceId: 'prov-1',
  cityId: 'city-1',
  districtId: 'dist-1',
  villageId: 'vill-1',
  postalCode: '40562',
  latitude: -6.87,
  longitude: 107.61,
  fullAddress: 'Jl. Pelanggan No.7',
  addressDetail: 'Blok C',
  province: { name: 'Jawa Barat' },
  city: { name: 'Kabupaten Bandung Barat' },
  district: { name: 'Cihampelas' },
  village: { name: 'Pataruman' },
};

/** Counts one "HTTP" call per service, exactly as PaxelProvider.getRates does. */
function buildCountingSetup() {
  const rateCalls: string[] = [];
  const paxel = {
    name: 'paxel',
    getRates: jest.fn(async () =>
      PAXEL_SERVICES.map((service) => {
        rateCalls.push(service);
        return {
          provider: 'paxel',
          service,
          serviceName: `Paxel ${service}`,
          estimatedDays: '00:00-24:00',
          shippingCost: service === 'PAXEL_INSTANT' ? 44000 : 78000,
        };
      }),
    ),
  };
  const factory = { getAll: () => [paxel] };
  const shipping = new ShippingService(factory as never);

  const prisma = {
    address: { findFirst: jest.fn().mockResolvedValue(ADDRESS) },
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET) },
    promo: { findFirst: jest.fn().mockResolvedValue(null) },
  };

  // Mirrors InventoryAllocationService: it prices the candidate outlet through
  // the same ShippingService, then hands back both the request and the quotes.
  const allocation = {
    allocate: jest.fn(async () => {
      const quotes = await shipping.getQuotes({} as never);
      return { outletId: OUTLET.id, outlet: { ...OUTLET, address: OUTLET.addressDetail }, quotes };
    }),
  };

  const service = new OrdersService(
    prisma as never,
    shipping as never,
    { isCheckoutEnabled: () => false } as never,
    { issue: jest.fn() } as never,
    undefined,
    undefined,
    allocation as never,
  );
  return { service, rateCalls };
}

const summaryDto = {
  address_id: 'addr-1',
  courier: 'paxel',
  shipping_provider: 'paxel',
  shipping_service: 'PAXEL_INSTANT',
  items: [{ product_id: 'p1', qty: 1 }],
};

describe('Paxel RATE call count per checkout operation', () => {
  it('getSummary costs 4 provider calls, not 8', async () => {
    const { service, rateCalls } = buildCountingSetup();

    await service.getSummary(USER, summaryDto as never);

    expect(rateCalls).toHaveLength(4);
    expect(rateCalls).toEqual(PAXEL_SERVICES);
  });

  it('getShippingOptions still costs 4 provider calls', async () => {
    const { service, rateCalls } = buildCountingSetup();

    await service.getShippingOptions(USER, {
      address_id: 'addr-1',
      items: [{ product_id: 'p1', qty: 1 }],
    } as never);

    expect(rateCalls).toHaveLength(4);
  });

  it('a payment-channel switch (second summary) costs 4, not 8', async () => {
    const { service, rateCalls } = buildCountingSetup();

    await service.getSummary(USER, { ...summaryDto, payment_method: 'GATEWAY', payment_channel: 'QRIS' } as never);
    const afterFirst = rateCalls.length;
    await service.getSummary(USER, { ...summaryDto, payment_method: 'GATEWAY', payment_channel: 'GOPAY' } as never);

    expect(afterFirst).toBe(4);
    expect(rateCalls).toHaveLength(8); // two summaries x 4, previously 16
  });
});
