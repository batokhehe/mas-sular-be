import { BadRequestException } from '@nestjs/common';
import { OrdersService } from '../../src/modules/orders/orders.service';

const USER = 'user-1';
const PRODUCT = { id: 'p1', name: 'Baso', price: 45000, stock: 10, status: 'ACTIVE', deletedAt: null };

const ACTIVE_OUTLET = {
  id: 'outlet-1',
  name: 'Bakso Mas Sular Pusat',
  postalCode: '40111',
  latitude: -6.9147,
  longitude: 107.6098,
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
    expect(request.weightGram).toBe(2 * 500);
  });

  it('rejects checkout when the destination address is missing a postal code', async () => {
    const { service, shipping } = build(buildPrisma(address({ postalCode: null })));
    await expect(service.getShippingOptions(USER, dto as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(shipping.getQuotes).not.toHaveBeenCalled();
  });
});
