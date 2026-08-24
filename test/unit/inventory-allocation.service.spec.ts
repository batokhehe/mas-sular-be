import { BadRequestException } from '@nestjs/common';
import { InventoryAllocationService } from '../../src/modules/inventory/inventory-allocation.service';

const ADDRESS = {
  provinceId: 'prov-1', cityId: 'city-1', districtId: null, villageId: null,
  postalCode: '40131', latitude: -6.9, longitude: 107.6,
};

function inv(outletId: string, lat: number, lng: number, stock: number, reserved = 0, productId = 'p1') {
  return {
    productId, outletId, stock, reserved, available: stock - reserved,
    outlet: { id: outletId, name: outletId, postalCode: outletId, latitude: lat, longitude: lng },
  };
}

function quote(cost: number, eta = '2 Days') {
  return [{ provider: 'jne', service: 'REG', serviceName: 'JNE Regular', estimatedDays: eta, shippingCost: cost }];
}

function build(inventories: unknown[], quotesByOrigin: Record<string, number>) {
  const prisma = {
    productInventory: { findMany: jest.fn().mockResolvedValue(inventories) },
    outlet: { findFirst: jest.fn().mockResolvedValue({ id: 'active', name: 'Active', postalCode: 'active', latitude: -6.9, longitude: 107.6 }) },
  };
  const shipping = {
    getQuotes: jest.fn().mockImplementation((req: { originPostalCode: string }) => Promise.resolve(quote(quotesByOrigin[req.originPostalCode] ?? 15000))),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new InventoryAllocationService(prisma as any, shipping as any);
  return { service, prisma, shipping };
}

const items = [{ productId: 'p1', quantity: 2 }];

describe('InventoryAllocationService', () => {
  it('chooses the NEAREST outlet when other factors tie', async () => {
    // outletA is at the address; outletB is far. Same shipping cost.
    const { service } = build(
      [inv('outletA', -6.9, 107.6, 10), inv('outletB', -8.5, 110.2, 10)],
      { outletA: 15000, outletB: 15000 },
    );
    const result = await service.allocate(items, ADDRESS, 1000);
    expect(result.outletId).toBe('outletA');
    expect(result.usedFallback).toBe(false);
  });

  it('chooses the LOWEST-shipping outlet when distance ties', async () => {
    const { service } = build(
      [inv('cheap', -6.9, 107.6, 10), inv('pricey', -6.9, 107.6, 10)],
      { cheap: 10000, pricey: 25000 },
    );
    const result = await service.allocate(items, ADDRESS, 1000);
    expect(result.outletId).toBe('cheap');
  });

  it('rejects checkout when no single outlet has all items in stock', async () => {
    // Only 1 available at each, but 2 requested → no candidate.
    const { service } = build(
      [inv('o1', -6.9, 107.6, 1), inv('o2', -6.9, 107.6, 1)],
      { o1: 10000, o2: 10000 },
    );
    await expect(service.allocate(items, ADDRESS, 1000)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('falls back to the active outlet while ProductInventory is empty (migration)', async () => {
    const { service, shipping } = build([], {});
    const result = await service.allocate(items, ADDRESS, 1000);
    expect(result.usedFallback).toBe(true);
    expect(result.outletId).toBe('active');
    expect(shipping.getQuotes).toHaveBeenCalled();
  });
});

// The allocation path builds its own ShippingRateRequest, so it has to carry the
// same master-address names as the orders path — otherwise a multi-outlet order
// would reach Paxel without the fields it marks required.
describe('InventoryAllocationService — address names reach the provider', () => {
  const NAMED_ADDRESS = {
    ...ADDRESS,
    address: 'Jl. Pelanggan No.7',
    province: 'Jawa Barat',
    city: 'Kota Bandung',
    district: 'Sukajadi',
    village: 'Pasteur',
  };

  function namedInv(outletId: string) {
    return {
      productId: 'p1', outletId, stock: 10, reserved: 0, available: 10,
      outlet: {
        id: outletId, name: outletId, postalCode: outletId, latitude: -6.9, longitude: 107.6,
        addressDetail: 'Jl. Outlet No.1',
        province: { name: 'Jawa Barat' },
        city: { name: 'Kota Bandung' },
        district: { name: 'Coblong' },
        village: { name: 'Dago' },
      },
    };
  }

  it('forwards origin and destination names on the candidate path', async () => {
    const { service, shipping } = build([namedInv('outletA')], { outletA: 15000 });
    await service.allocate(items, NAMED_ADDRESS, 1000);

    const request = shipping.getQuotes.mock.calls[0][0];
    expect(request.originCity).toBe('Kota Bandung');
    expect(request.originDistrict).toBe('Coblong');
    expect(request.destinationAddress).toBe('Jl. Pelanggan No.7');
    expect(request.destinationProvince).toBe('Jawa Barat');
    expect(request.destinationCity).toBe('Kota Bandung');
    expect(request.destinationDistrict).toBe('Sukajadi');
  });

  it('returns the chosen outlet with its region names so the caller can re-quote', async () => {
    const { service } = service_with_named();
    const result = await service.allocate(items, NAMED_ADDRESS, 1000);
    expect(result.outlet).toEqual(
      expect.objectContaining({ city: 'Kota Bandung', district: 'Coblong', province: 'Jawa Barat' }),
    );
  });

  function service_with_named() {
    return build([namedInv('outletA')], { outletA: 15000 });
  }

  it('loads the region relations on the candidate query', async () => {
    const { service, prisma } = build([namedInv('outletA')], { outletA: 15000 });
    await service.allocate(items, NAMED_ADDRESS, 1000);

    const include = prisma.productInventory.findMany.mock.calls[0][0].include;
    expect(include.outlet.include).toEqual(
      expect.objectContaining({
        province: { select: { name: true } },
        city: { select: { name: true } },
        district: { select: { name: true } },
        village: { select: { name: true } },
      }),
    );
  });
});

// ==================================================== PaxelBox integration ==
// PAXELBOX-3: `allocate()` builds its own ShippingRateRequest (candidate
// scoring AND the migration fallback), so both paths must carry `paxelBoxSize`
// independently of OrdersService — reusing selectPaxelBox(), never a second
// copy of the S/M/L/XL thresholds.

describe('InventoryAllocationService — PaxelBox reaches both request paths', () => {
  it('candidate-scoring path: total quantity 2 -> PaxelBox S', async () => {
    const { service, shipping } = build([inv('outletA', -6.9, 107.6, 10)], { outletA: 15000 });
    await service.allocate(items, ADDRESS, 1000); // items = [{ productId: 'p1', quantity: 2 }]

    const request = shipping.getQuotes.mock.calls[0][0];
    expect(request.paxelBoxSize).toBe('S');
  });

  it('migration-fallback path (no ProductInventory yet) also carries paxelBoxSize', async () => {
    const { service, shipping } = build([], {});
    await service.allocate(items, ADDRESS, 1000);

    const request = shipping.getQuotes.mock.calls[0][0];
    expect(request.paxelBoxSize).toBe('S');
  });

  it('sums quantity across multiple SKUs on the candidate path, not per-item', async () => {
    // p1 x3 + p2 x6 = 9 total -> M, mirroring the same worked example
    // OrdersService is tested against, at this independent call site.
    const multiItems = [
      { productId: 'p1', quantity: 3 },
      { productId: 'p2', quantity: 6 },
    ];
    const invs = [
      inv('outletA', -6.9, 107.6, 10, 0, 'p1'),
      inv('outletA', -6.9, 107.6, 10, 0, 'p2'),
    ];
    const { service, shipping } = build(invs, { outletA: 15000 });
    await service.allocate(multiItems, ADDRESS, 1000);

    const request = shipping.getQuotes.mock.calls[0][0];
    expect(request.paxelBoxSize).toBe('M');
  });

  it('quantity 21 on the fallback path -> PaxelBox XL', async () => {
    const { service, shipping } = build([], {});
    await service.allocate([{ productId: 'p1', quantity: 21 }], ADDRESS, 1000);

    expect(shipping.getQuotes.mock.calls[0][0].paxelBoxSize).toBe('XL');
  });
});
