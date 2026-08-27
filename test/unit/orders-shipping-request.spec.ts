import { BadRequestException } from '@nestjs/common';
import { OrdersService } from '../../src/modules/orders/orders.service';

const USER = 'user-1';
const PRODUCT = { id: 'p1', name: 'Baso', price: 45000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 250 };

const ACTIVE_OUTLET = {
  id: 'outlet-1',
  name: 'Bakso Mas Sular Pusat',
  postalCode: '40111',
  latitude: -6.9147,
  longitude: 107.6098,
  addressDetail: 'Jl. Outlet Pusat No.1',
  province: { name: 'Jawa Barat' },
  city: { name: 'Kota Bandung' },
  district: { name: 'Coblong' },
  village: { name: 'Dago' },
};

function address(overrides: Record<string, unknown> = {}) {
  return {
    id: 'addr-1',
    userId: USER,
    deletedAt: null,
    provinceId: 'prov-1',
    cityId: 'city-1',
    districtId: 'dist-1',
    villageId: 'vill-1',
    postalCode: '40131',
    latitude: -6.9,
    longitude: 107.6,
    fullAddress: 'Jl. Pelanggan No.7',
    addressDetail: 'Blok C',
    province: { name: 'Jawa Barat' },
    city: { name: 'Kota Bandung' },
    district: { name: 'Sukajadi' },
    village: { name: 'Pasteur' },
    ...overrides,
  };
}

function buildPrisma(addr = address(), outlet: unknown = ACTIVE_OUTLET) {
  return {
    address: { findFirst: jest.fn().mockResolvedValue(addr) },
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    outlet: { findFirst: jest.fn().mockResolvedValue(outlet) },
  };
}

function build(prisma: ReturnType<typeof buildPrisma>) {
  const shipping = { getQuotes: jest.fn().mockResolvedValue([]) };
  const idempotency = { isCheckoutEnabled: jest.fn().mockReturnValue(false) };
  const uploadTokens = { issue: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new OrdersService(prisma as any, shipping as any, idempotency as any, uploadTokens as any);
  return { service, shipping };
}

const dto = { address_id: 'addr-1', items: [{ product_id: 'p1', qty: 2 }] };

describe('OrdersService — real shipping request', () => {
  it('builds the provider request from the active outlet + customer address (no placeholders)', async () => {
    const { service, shipping } = build(buildPrisma());
    await service.getShippingOptions(USER, dto as never);

    expect(shipping.getQuotes).toHaveBeenCalledTimes(1);
    const request = shipping.getQuotes.mock.calls[0][0];
    expect(request.originPostalCode).toBe('40111'); // outlet, not '00000'
    expect(request.destinationPostalCode).toBe('40131'); // address, not 'customer-address'
    expect(request.originLatitude).toBe(-6.9147);
    expect(request.destinationLatitude).toBe(-6.9);
    // PAXELBOX-5: real product weight, not the old `totalItems * 500g`.
    expect(request.weightGram).toBe(2 * 250);
  });

  it('rejects checkout when the destination address is missing a postal code', async () => {
    const { service, shipping } = build(buildPrisma(address({ postalCode: null })));
    await expect(service.getShippingOptions(USER, dto as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(shipping.getQuotes).not.toHaveBeenCalled();
  });
});

// Paxel prices on place NAMES (its /rates/city marks destination
// address/province/city/district and origin city/district as required), so the
// request builder has to carry them. Postal codes alone are not enough.
describe('OrdersService — master-address names reach the provider', () => {
  it('maps the outlet region names onto the origin', async () => {
    const { service, shipping } = build(buildPrisma());
    await service.getShippingOptions(USER, dto as never);
    const request = shipping.getQuotes.mock.calls[0][0];

    expect(request.originAddress).toBe('Jl. Outlet Pusat No.1');
    expect(request.originProvince).toBe('Jawa Barat');
    expect(request.originCity).toBe('Kota Bandung');
    expect(request.originDistrict).toBe('Coblong');
    expect(request.originVillage).toBe('Dago');
  });

  it('maps the customer address region names onto the destination', async () => {
    const { service, shipping } = build(buildPrisma());
    await service.getShippingOptions(USER, dto as never);
    const request = shipping.getQuotes.mock.calls[0][0];

    expect(request.destinationAddress).toBe('Jl. Pelanggan No.7');
    expect(request.destinationProvince).toBe('Jawa Barat');
    expect(request.destinationCity).toBe('Kota Bandung');
    expect(request.destinationDistrict).toBe('Sukajadi');
    expect(request.destinationVillage).toBe('Pasteur');
  });

  it('leaves a name undefined rather than inventing one when the relation is unset', async () => {
    const { service, shipping } = build(buildPrisma(address({ district: null, village: null })));
    await service.getShippingOptions(USER, dto as never);
    const request = shipping.getQuotes.mock.calls[0][0];

    expect(request.destinationDistrict).toBeUndefined();
    expect(request.destinationVillage).toBeUndefined();
    // never substituted with a postal code or an id
    expect(request.destinationDistrict).not.toBe('40131');
    expect(request.destinationDistrict).not.toBe('dist-1');
  });

  it('still loads the region relations on both queries', async () => {
    const prisma = buildPrisma();
    const { service } = build(prisma);
    await service.getShippingOptions(USER, dto as never);

    for (const call of [prisma.address.findFirst.mock.calls[0][0], prisma.outlet.findFirst.mock.calls[0][0]]) {
      expect(call.include).toEqual(
        expect.objectContaining({
          province: { select: { name: true } },
          city: { select: { name: true } },
          district: { select: { name: true } },
          village: { select: { name: true } },
        }),
      );
    }
  });
});

// ==================================================== PaxelBox integration ==
// PAXELBOX-3: the box is chosen from TOTAL ORDER QUANTITY and reaches the
// provider as `paxelBoxSize` on the exact same request JNE/legacy callers see
// (JNE simply ignores the field). SKU, product dimensions and weight play no
// part in this — only SUM(OrderItem.quantity).

describe('OrdersService — PaxelBox reaches the real shipping request', () => {
  it.each([
    [1, 'S'], [3, 'S'],
    [4, 'M'], [10, 'M'],
    [11, 'L'], [20, 'L'],
    // PAXELBOX-17: these asserted 'XL'. XL is out of scope, so past L the
    // request carries null and PaxelProvider offers nothing for the order.
    [21, null], [100, null],
  ] as const)('total quantity %i -> PaxelBox %s on the outgoing request', async (qty, expected) => {
    const { service, shipping } = build(buildPrisma());
    await service.getShippingOptions(USER, { address_id: 'addr-1', items: [{ product_id: 'p1', qty }] } as never);

    const request = shipping.getQuotes.mock.calls[0][0];
    expect(request.paxelBoxSize).toBe(expected);
  });

  it('a multi-SKU cart uses the SUM of quantities, not per-line or per-SKU logic', async () => {
    // SKU A x2 + SKU B x3 + SKU C x4 = 9 total -> PaxelBox M, exactly the
    // worked example from the phase brief. Three different products,
    // deliberately never inspected for size/weight/dimension.
    const products = [
      { id: 'pA', name: 'Baso A', price: 45000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 250 },
      { id: 'pB', name: 'Baso B', price: 50000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 300 },
      { id: 'pC', name: 'Es Teh', price: 8000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 400 },
    ];
    const prisma = buildPrisma();
    prisma.product.findMany = jest.fn().mockResolvedValue(products);
    const { service, shipping } = build(prisma);

    await service.getShippingOptions(USER, {
      address_id: 'addr-1',
      items: [
        { product_id: 'pA', qty: 2 },
        { product_id: 'pB', qty: 3 },
        { product_id: 'pC', qty: 4 },
      ],
    } as never);

    const request = shipping.getQuotes.mock.calls[0][0];
    expect(request.paxelBoxSize).toBe('M');
  });

  it('never reads Product physical fields to pick the box — quantity alone decides', async () => {
    // A "product" carrying box-sized physical data on purpose: if the selector
    // ever started reading Product.lengthCm/weightGram, this would silently
    // change the outcome. It must not — quantity 2 is S regardless.
    const prisma = buildPrisma();
    prisma.product.findMany = jest.fn().mockResolvedValue([
      { id: 'p1', name: 'Baso', price: 45000, stock: 10, status: 'ACTIVE', deletedAt: null,
        weightGram: 59000, lengthCm: 59, widthCm: 47, heightCm: 47, isFragile: true },
    ]);
    const { service, shipping } = build(prisma);
    await service.getShippingOptions(USER, { address_id: 'addr-1', items: [{ product_id: 'p1', qty: 2 }] } as never);

    expect(shipping.getQuotes.mock.calls[0][0].paxelBoxSize).toBe('S');
  });
});

// ================================================ PAXELBOX-5: real weight ==
// RATE weight is now SUM(Product.weightGram x quantity), replacing the legacy
// `totalItems x 500g`. The WEIGHT axis and the BOX axis are deliberately
// independent: weight comes from real product data, the box comes only from
// total quantity.

describe('OrdersService — RATE weight comes from real product data', () => {
  it('1 SKU x quantity uses the actual product weight', async () => {
    const { service, shipping } = build(buildPrisma()); // PRODUCT weighs 250g
    await service.getShippingOptions(USER, { address_id: 'addr-1', items: [{ product_id: 'p1', qty: 4 }] } as never);

    expect(shipping.getQuotes.mock.calls[0][0].weightGram).toBe(4 * 250);
  });

  it('sums the ACTUAL weights across multiple SKUs, not a flat per-item constant', async () => {
    const prisma = buildPrisma();
    prisma.product.findMany = jest.fn().mockResolvedValue([
      { id: 'pA', name: 'Baso A', price: 45000, stock: 99, status: 'ACTIVE', deletedAt: null, weightGram: 250 },
      { id: 'pB', name: 'Mie', price: 20000, stock: 99, status: 'ACTIVE', deletedAt: null, weightGram: 120 },
      { id: 'pC', name: 'Es Teh', price: 8000, stock: 99, status: 'ACTIVE', deletedAt: null, weightGram: 400 },
    ]);
    const { service, shipping } = build(prisma);
    await service.getShippingOptions(USER, {
      address_id: 'addr-1',
      items: [
        { product_id: 'pA', qty: 2 },
        { product_id: 'pB', qty: 3 },
        { product_id: 'pC', qty: 1 },
      ],
    } as never);

    // 2*250 + 3*120 + 1*400 = 1260. The old placeholder would have said 6*500=3000.
    expect(shipping.getQuotes.mock.calls[0][0].weightGram).toBe(1260);
    expect(shipping.getQuotes.mock.calls[0][0].weightGram).not.toBe(6 * 500);
  });

  it('11+ items are no longer forced over the 5000g city cap by the placeholder', async () => {
    // The regression PAXELBOX-4 surfaced: 11 x 500g = 5500g exceeded Paxel's
    // /rates/city cap, so SAMEDAY/NEXTDAY/REGULAR silently produced no quote.
    // With real weights, 11 light items stay well inside the cap.
    const { service, shipping } = build(buildPrisma()); // 250g each
    await service.getShippingOptions(USER, { address_id: 'addr-1', items: [{ product_id: 'p1', qty: 11 }] } as never);

    const request = shipping.getQuotes.mock.calls[0][0];
    expect(request.weightGram).toBe(11 * 250); // 2750g
    expect(request.weightGram).toBeLessThanOrEqual(5000);
    expect(11 * 500).toBeGreaterThan(5000); // what the old placeholder would have produced
  });

  it('refuses a product with no configured weight instead of guessing 500g', async () => {
    const prisma = buildPrisma();
    prisma.product.findMany = jest.fn().mockResolvedValue([
      { id: 'p1', name: 'Baso Tanpa Berat', price: 45000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: null },
    ]);
    const { service, shipping } = build(prisma);

    await expect(
      service.getShippingOptions(USER, { address_id: 'addr-1', items: [{ product_id: 'p1', qty: 2 }] } as never),
    ).rejects.toThrow(/Baso Tanpa Berat has no weight configured/);
    expect(shipping.getQuotes).not.toHaveBeenCalled();
  });

  it('names every unweighed product, and never quotes a partial weight', async () => {
    const prisma = buildPrisma();
    prisma.product.findMany = jest.fn().mockResolvedValue([
      { id: 'pA', name: 'Baso A', price: 45000, stock: 99, status: 'ACTIVE', deletedAt: null, weightGram: 250 },
      { id: 'pB', name: 'Mie', price: 20000, stock: 99, status: 'ACTIVE', deletedAt: null, weightGram: null },
      { id: 'pC', name: 'Es Teh', price: 8000, stock: 99, status: 'ACTIVE', deletedAt: null, weightGram: null },
    ]);
    const { service, shipping } = build(prisma);

    await expect(
      service.getShippingOptions(USER, {
        address_id: 'addr-1',
        items: [{ product_id: 'pA', qty: 1 }, { product_id: 'pB', qty: 1 }, { product_id: 'pC', qty: 1 }],
      } as never),
    ).rejects.toThrow(/Mie, Es Teh have no weight configured/);
    expect(shipping.getQuotes).not.toHaveBeenCalled();
  });
});

describe('OrdersService — weight and box stay independent axes', () => {
  it('a heavy product does not change the box; a light one does not either — only quantity does', async () => {
    const heavy = buildPrisma();
    heavy.product.findMany = jest.fn().mockResolvedValue([
      { id: 'p1', name: 'Berat', price: 45000, stock: 99, status: 'ACTIVE', deletedAt: null,
        weightGram: 4000, lengthCm: 50, widthCm: 50, heightCm: 50, isFragile: true },
    ]);
    const a = build(heavy);
    await a.service.getShippingOptions(USER, { address_id: 'addr-1', items: [{ product_id: 'p1', qty: 2 }] } as never);
    const heavyReq = a.shipping.getQuotes.mock.calls[0][0];

    const light = buildPrisma();
    light.product.findMany = jest.fn().mockResolvedValue([
      { id: 'p1', name: 'Ringan', price: 45000, stock: 99, status: 'ACTIVE', deletedAt: null,
        weightGram: 5, lengthCm: 1, widthCm: 1, heightCm: 1, isFragile: false },
    ]);
    const b = build(light);
    await b.service.getShippingOptions(USER, { address_id: 'addr-1', items: [{ product_id: 'p1', qty: 2 }] } as never);
    const lightReq = b.shipping.getQuotes.mock.calls[0][0];

    // Same quantity (2) -> same box, despite an 800x weight difference and
    // wildly different product dimensions.
    expect(heavyReq.paxelBoxSize).toBe('S');
    expect(lightReq.paxelBoxSize).toBe('S');
    // ...while the weight axis correctly reflects the real products.
    expect(heavyReq.weightGram).toBe(8000);
    expect(lightReq.weightGram).toBe(10);
  });
});
