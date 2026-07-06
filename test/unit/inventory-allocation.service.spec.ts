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
