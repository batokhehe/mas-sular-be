import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { OrdersModule } from '../../src/modules/orders/orders.module';
import { InventoryModule } from '../../src/modules/inventory/inventory.module';
import { InventoryAllocationService } from '../../src/modules/inventory/inventory-allocation.service';
import { DeliveryCoverageModule } from '../../src/modules/delivery-coverage/delivery-coverage.module';

/**
 * DeliveryCoverage is deactivated in the shipping flow: Paxel decides whether it
 * can ship somewhere and what it costs.
 *
 * The gate used to run BEFORE the rate request, so a DISABLED or PICKUP_ONLY
 * rule stopped an address from ever reaching Paxel — staging carried exactly
 * such rules (Kota Surabaya DISABLED, Cileunyi PICKUP_ONLY), which would have
 * hidden Paxel services from areas Paxel actually serves.
 *
 * Deactivation is by wiring, not by deleting logic: both consumers inject
 * DeliveryCoverageService with @Optional(), so leaving the module unwired makes
 * the gate a no-op. These tests pin both halves — the wiring, and the behaviour
 * that wiring produces — and the contrast cases prove the gate itself still
 * works, so re-enabling it is a one-line change.
 */

const USER = 'user-1';
const PRODUCT = { id: 'p1', name: 'Baso', price: 45000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 250 };

const OUTLET = {
  id: 'outlet-1',
  name: 'Bakso Mas Sular Pusat',
  postalCode: '12210',
  latitude: -6.244392,
  longitude: 106.776544,
  addressDetail: 'Jl. Sultan Iskandar Muda No.6C',
  province: { name: 'DKI Jakarta' },
  city: { name: 'Kota Administrasi Jakarta Selatan' },
  district: { name: 'Kebayoran Baru' },
  village: { name: 'Melawai' },
};

/** A Surabaya address — exactly the kind staging marks DISABLED. */
function address(overrides: Record<string, unknown> = {}) {
  return {
    id: 'addr-1',
    userId: USER,
    deletedAt: null,
    provinceId: 'prov-35',
    cityId: 'city-3578',
    districtId: 'dist-1',
    villageId: 'vill-1',
    postalCode: '60271',
    latitude: -7.29,
    longitude: 112.73,
    fullAddress: 'Jl. Pelanggan No.7',
    addressDetail: 'Blok C',
    province: { name: 'Jawa Timur' },
    city: { name: 'Kota Surabaya' },
    district: { name: 'Genteng' },
    village: { name: 'Embong Kaliasin' },
    ...overrides,
  };
}

const PAXEL_QUOTES = [
  { provider: 'paxel', service: 'PAXEL_SAMEDAY', serviceName: 'Paxel Same Day', shippingCost: 23000 },
  { provider: 'paxel', service: 'PAXEL_NEXTDAY', serviceName: 'Paxel Next Day', shippingCost: 21000 },
];

function buildOrders(opts: { coverage?: unknown; quotes?: unknown[]; addr?: Record<string, unknown> } = {}) {
  const prisma = {
    address: { findFirst: jest.fn().mockResolvedValue(opts.addr ?? address()) },
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET) },
  };
  const shipping = { getQuotes: jest.fn().mockResolvedValue(opts.quotes ?? PAXEL_QUOTES) };
  const idempotency = { isCheckoutEnabled: jest.fn().mockReturnValue(false) };
  const uploadTokens = { issue: jest.fn() };
  const service = new OrdersService(
    prisma as never,
    shipping as never,
    idempotency as never,
    uploadTokens as never,
    // Production now leaves this undefined; a stub is passed only to prove the
    // contrast in the "still works when wired" cases below.
    ...((opts.coverage === undefined ? [] : [opts.coverage]) as []),
  );
  return { service, shipping, prisma };
}

const dto = { address_id: 'addr-1', items: [{ product_id: 'p1', qty: 2 }] };

// ============================================================ module wiring ==

describe('module wiring — DeliveryCoverage is not a dependency of the shipping flow', () => {
  it('OrdersModule does not import DeliveryCoverageModule', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, OrdersModule) ?? []) as unknown[];
    expect(imports).not.toContain(DeliveryCoverageModule);
  });

  it('InventoryModule does not import DeliveryCoverageModule', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, InventoryModule) ?? []) as unknown[];
    expect(imports).not.toContain(DeliveryCoverageModule);
  });
});

// ================================================== rates reach the provider ==

describe('shipping options no longer pass through a coverage gate', () => {
  it('1+2: an address with no coverage rule still reaches the shipping provider', async () => {
    const { service, shipping } = buildOrders();
    const quotes = await service.getShippingOptions(USER, dto as never);

    expect(shipping.getQuotes).toHaveBeenCalledTimes(1);
    expect(quotes).toEqual(PAXEL_QUOTES);
  });

  it('2: an address that a DISABLED rule would have blocked still reaches the provider', async () => {
    // No coverage service wired — the same address that staging marks DISABLED.
    const { service, shipping } = buildOrders();
    await expect(service.getShippingOptions(USER, dto as never)).resolves.toEqual(PAXEL_QUOTES);
    expect(shipping.getQuotes).toHaveBeenCalledTimes(1);
  });

  it('an incomplete address is still refused — by address validation, not by coverage', async () => {
    // This one SHOULD be rejected, and the reason matters: province/city are
    // required to build any courier request at all. Pinning the message keeps
    // the two concerns from being confused if the gate is ever reinstated.
    const { service, shipping } = buildOrders({
      addr: address({ provinceId: null, cityId: null, districtId: null, villageId: null }),
    });
    await expect(service.getShippingOptions(USER, dto as never)).rejects.toThrow(
      /missing required fields for shipping/i,
    );
    expect(shipping.getQuotes).not.toHaveBeenCalled();
  });

  it('3: provider unavailability is the provider’s answer, not the gate’s', async () => {
    // Paxel returned nothing for this lane (e.g. HTTP 400 "price not available").
    const { service, shipping } = buildOrders({ quotes: [] });
    await expect(service.getShippingOptions(USER, dto as never)).resolves.toEqual([]);
    expect(shipping.getQuotes).toHaveBeenCalledTimes(1);
  });

  it('4: the shipping price is the provider’s price, untouched by coverage', async () => {
    const { service } = buildOrders();
    const quotes = await service.getShippingOptions(USER, dto as never);
    expect(quotes.map((q) => q.shippingCost)).toEqual([23000, 21000]);
  });

  it('5: a non-Paxel provider is passed through unchanged', async () => {
    const jne = [{ provider: 'jne', service: 'REG', serviceName: 'JNE Reguler', shippingCost: 18000 }];
    const { service, shipping } = buildOrders({ quotes: jne });
    await expect(service.getShippingOptions(USER, dto as never)).resolves.toEqual(jne);
    expect(shipping.getQuotes).toHaveBeenCalledTimes(1);
  });
});

// ==================================== the gate itself is intact, just unwired ==

describe('the coverage gate still works when deliberately wired back in', () => {
  it('DISABLED blocks before the provider is called', async () => {
    const coverage = { resolve: jest.fn().mockResolvedValue({ id: 'cov-1', coverageType: 'DISABLED' }) };
    const { service, shipping } = buildOrders({ coverage });

    await expect(service.getShippingOptions(USER, dto as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(shipping.getQuotes).not.toHaveBeenCalled();
  });

  it('PICKUP_ONLY blocks before the provider is called', async () => {
    const coverage = { resolve: jest.fn().mockResolvedValue({ id: 'cov-2', coverageType: 'PICKUP_ONLY' }) };
    const { service, shipping } = buildOrders({ coverage });

    await expect(service.getShippingOptions(USER, dto as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(shipping.getQuotes).not.toHaveBeenCalled();
  });
});

// ========================================================= outlet allocation ==

describe('outlet allocation no longer refuses an address before the courier is asked', () => {
  it('6: assertCoverage is inert when DeliveryCoverageService is not wired', async () => {
    const prisma = { productInventory: { findMany: jest.fn().mockResolvedValue([]) } };
    const shipping = { getQuotes: jest.fn().mockResolvedValue([]) };
    const allocation = new InventoryAllocationService(prisma as never, shipping as never);

    // Allocation may still fail later for unrelated reasons (no outlet, no
    // stock) — what matters here is that it is never the coverage gate that
    // stops it, so the assertion is on the reason rather than on success.
    const addr = { provinceId: 'prov-35', cityId: 'city-3578', districtId: null, villageId: null } as never;
    const outcome = await allocation.allocate([], addr, 1000).catch((e: unknown) => e);
    const message = outcome instanceof Error ? outcome.message : '';
    expect(message).not.toMatch(/do not currently deliver|only available for Pickup/i);
  });

  it('the allocation gate still blocks when wired back in', async () => {
    const prisma = { productInventory: { findMany: jest.fn().mockResolvedValue([]) } };
    const shipping = { getQuotes: jest.fn().mockResolvedValue([]) };
    const coverage = { resolve: jest.fn().mockResolvedValue({ id: 'c', coverageType: 'DISABLED' }) };
    const allocation = new InventoryAllocationService(prisma as never, shipping as never, coverage as never);

    const addr = { provinceId: 'prov-35', cityId: 'city-3578', districtId: null, villageId: null } as never;
    await expect(allocation.allocate([], addr, 1000)).rejects.toBeInstanceOf(BadRequestException);
  });
});
