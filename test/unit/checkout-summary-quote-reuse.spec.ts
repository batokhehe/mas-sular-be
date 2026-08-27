import { BadRequestException } from '@nestjs/common';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { ShippingService } from '../../src/modules/shipping/shipping.service';

/**
 * getSummary() used to price the cart TWICE: allocation quoted the chosen
 * outlet, that result was discarded, and findQuote() then re-quoted every
 * courier service just to pick one. For Paxel that is 4 extra HTTP calls per
 * summary, and the summary refetches on every payment-channel switch.
 *
 * These tests pin the reuse: allocation's quotes must be the ones used, the
 * second fan-out must not happen, and the unavailable-service error is unchanged.
 */

const USER = 'user-1';
const PRODUCT = { id: 'p1', name: 'Keju', price: 45000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 200 };

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

const PAXEL_INSTANT = {
  provider: 'paxel',
  service: 'PAXEL_INSTANT',
  serviceName: 'Paxel Instant',
  estimatedDays: '00:00-24:00',
  shippingCost: 44000,
};
const PAXEL_SAMEDAY = {
  provider: 'paxel',
  service: 'PAXEL_SAMEDAY',
  serviceName: 'Paxel Same Day',
  estimatedDays: '18:00-22:00',
  shippingCost: 78000,
};
const JNE_REG = {
  provider: 'jne',
  service: 'REG',
  serviceName: 'JNE Reguler (Mock)',
  estimatedDays: '2-3 Days',
  shippingCost: 9000,
};
const ALLOCATOR_QUOTES = [PAXEL_INSTANT, PAXEL_SAMEDAY, JNE_REG];

/** Real selection logic, so the tests assert the production error, not a copy. */
const realSelect = (quotes: typeof ALLOCATOR_QUOTES, provider: string, service: string) =>
  new ShippingService({ getAll: () => [] } as never).selectQuote(quotes as never, provider, service);

function buildPrisma() {
  return {
    address: { findFirst: jest.fn().mockResolvedValue(ADDRESS) },
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET) },
    promo: { findFirst: jest.fn().mockResolvedValue(null) },
  };
}

/** withAllocation:false reproduces the legacy path where allocation is absent. */
function build(withAllocation = true) {
  const prisma = buildPrisma();
  // A real ShippingService fans out to every provider; spying on getQuotes is
  // exactly what proves the second fan-out is gone.
  const shipping = {
    getQuotes: jest.fn().mockResolvedValue(ALLOCATOR_QUOTES),
    findQuote: jest.fn(async (_request: unknown, provider: string, service: string) =>
      realSelect(ALLOCATOR_QUOTES, provider, service),
    ),
    selectQuote: jest.fn((quotes: typeof ALLOCATOR_QUOTES, provider: string, service: string) =>
      realSelect(quotes, provider, service),
    ),
    calculateRateForCourier: jest.fn(),
  };
  const allocation = {
    allocate: jest.fn().mockResolvedValue({
      outletId: OUTLET.id,
      outlet: { ...OUTLET, address: OUTLET.addressDetail },
      quotes: ALLOCATOR_QUOTES,
    }),
  };
  const idempotency = { isCheckoutEnabled: jest.fn().mockReturnValue(false) };
  const uploadTokens = { issue: jest.fn() };
  const service = new OrdersService(
    prisma as never,
    shipping as never,
    idempotency as never,
    uploadTokens as never,
    undefined,
    undefined,
    (withAllocation ? allocation : undefined) as never,
  );
  return { service, shipping, allocation };
}

const summaryDto = (over: Record<string, unknown> = {}) => ({
  address_id: 'addr-1',
  courier: 'paxel',
  shipping_provider: 'paxel',
  shipping_service: 'PAXEL_INSTANT',
  items: [{ product_id: 'p1', qty: 1 }],
  ...over,
});

describe('getSummary reuses allocation quotes', () => {
  it('does NOT re-quote: getQuotes and findQuote are never called again', async () => {
    const { service, shipping, allocation } = build();

    const summary = await service.getSummary(USER, summaryDto() as never);

    expect(allocation.allocate).toHaveBeenCalledTimes(1);
    // The whole point: no second fan-out for a lookup we already had.
    expect(shipping.getQuotes).not.toHaveBeenCalled();
    expect(shipping.findQuote).not.toHaveBeenCalled();
    expect(shipping.selectQuote).toHaveBeenCalledTimes(1);
    expect(summary.shipping_cost).toBe(44000);
  });

  it('selects the requested Paxel service out of the reused quotes', async () => {
    const { service } = build();
    const summary = await service.getSummary(USER, summaryDto({ shipping_service: 'PAXEL_SAMEDAY' }) as never);
    expect(summary.shipping.service).toBe('PAXEL_SAMEDAY');
    expect(summary.shipping_cost).toBe(78000);
  });

  it('selects a JNE service out of the reused quotes', async () => {
    const { service } = build();
    const summary = await service.getSummary(
      USER,
      summaryDto({ courier: 'jne', shipping_provider: 'jne', shipping_service: 'REG' }) as never,
    );
    expect(summary.shipping.provider).toBe('jne');
    expect(summary.shipping_cost).toBe(9000);
  });

  it('an unavailable service still raises the same error', async () => {
    const { service, shipping } = build();
    await expect(
      service.getSummary(USER, summaryDto({ shipping_service: 'PAXEL_NEXTDAY' }) as never),
    ).rejects.toThrow(new BadRequestException('Selected shipping service is unavailable'));
    expect(shipping.getQuotes).not.toHaveBeenCalled();
  });

  it('money still adds up from the reused quote', async () => {
    const { service } = build();
    const summary = await service.getSummary(USER, summaryDto() as never);
    expect(summary.subtotal).toBe(45000);
    expect(summary.shipping_cost).toBe(44000);
    expect(summary.discount).toBe(0);
    // Not a GATEWAY dto -> fee 0, so the total is the plain base.
    expect(summary.payment_service_fee).toBe(0);
    expect(summary.grand_total).toBe(89000);
  });

  it('QRIS fee is computed off the reused shipping cost, unchanged', async () => {
    const { service } = build();
    const summary = await service.getSummary(
      USER,
      summaryDto({ payment_method: 'GATEWAY', payment_channel: 'QRIS' }) as never,
    );
    // base 89000 -> round(89000 * 0.007) = 623
    expect(summary.payment_service_fee).toBe(623);
    expect(summary.grand_total).toBe(89623);
  });
});

describe('legacy path (no allocation service) is unchanged', () => {
  it('falls back to findQuote when allocation is absent', async () => {
    const { service, shipping } = build(false);
    const summary = await service.getSummary(USER, summaryDto() as never);
    // quotes === null on this path, so the on-demand quote must still happen.
    expect(shipping.findQuote).toHaveBeenCalledTimes(1);
    expect(shipping.selectQuote).not.toHaveBeenCalled();
    expect(summary.shipping_cost).toBe(44000);
  });

  it('legacy path still raises the same unavailable error', async () => {
    const { service } = build(false);
    await expect(
      service.getSummary(USER, summaryDto({ shipping_service: 'PAXEL_NEXTDAY' }) as never),
    ).rejects.toThrow(new BadRequestException('Selected shipping service is unavailable'));
  });
});

describe('getShippingOptions is untouched', () => {
  it('still returns the allocator quotes without a second fan-out', async () => {
    const { service, shipping } = build();
    const options = await service.getShippingOptions(USER, {
      address_id: 'addr-1',
      items: [{ product_id: 'p1', qty: 1 }],
    } as never);
    expect(options).toEqual(ALLOCATOR_QUOTES);
    expect(shipping.getQuotes).not.toHaveBeenCalled();
  });
});
