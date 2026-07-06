import { CoverageType } from '@prisma/client';
import { DeliveryCoverageService } from '../../src/modules/delivery-coverage/delivery-coverage.service';

type Row = {
  id: string;
  isActive: boolean;
  provinceId: string;
  cityId: string;
  districtId: string | null;
  villageId: string | null;
  coverageType: CoverageType;
  deliveryFee: number;
  minimumOrder: number;
  estimatedMinutes: number;
};

function whereMatches(row: Row, where: Record<string, unknown>): boolean {
  for (const key of ['isActive', 'provinceId', 'cityId', 'districtId', 'villageId'] as const) {
    if (!(key in where)) continue;
    const expected = where[key];
    if (expected === null) {
      if (row[key] !== null) return false;
    } else if (row[key] !== expected) {
      return false;
    }
  }
  return true;
}

function makeService(table: Row[]) {
  const prisma = {
    deliveryCoverage: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => table.find((r) => whereMatches(r, where)) ?? null),
    },
  };
  return new DeliveryCoverageService(prisma as never);
}

const base = { isActive: true, provinceId: 'P', cityId: 'C', coverageType: CoverageType.DELIVERY, deliveryFee: 0, minimumOrder: 0, estimatedMinutes: 60 };

describe('DeliveryCoverageService.resolve — priority village → district → city', () => {
  it('prefers the village rule when one exists', async () => {
    const svc = makeService([
      { ...base, id: 'city', districtId: null, villageId: null, deliveryFee: 15000 },
      { ...base, id: 'district', districtId: 'D', villageId: null, deliveryFee: 12000 },
      { ...base, id: 'village', districtId: 'D', villageId: 'V', deliveryFee: 10000 },
    ]);
    const match = await svc.resolve({ provinceId: 'P', cityId: 'C', districtId: 'D', villageId: 'V' });
    expect(match?.id).toBe('village');
    expect(match?.deliveryFee).toBe(10000);
  });

  it('falls back to the district rule when no village rule matches', async () => {
    const svc = makeService([
      { ...base, id: 'city', districtId: null, villageId: null },
      { ...base, id: 'district', districtId: 'D', villageId: null },
    ]);
    const match = await svc.resolve({ provinceId: 'P', cityId: 'C', districtId: 'D', villageId: 'V' });
    expect(match?.id).toBe('district');
  });

  it('falls back to the city rule when only a city rule exists', async () => {
    const svc = makeService([{ ...base, id: 'city', districtId: null, villageId: null }]);
    const match = await svc.resolve({ provinceId: 'P', cityId: 'C', districtId: 'D', villageId: 'V' });
    expect(match?.id).toBe('city');
  });

  it('returns null when the address has no province/city (legacy address)', async () => {
    const svc = makeService([{ ...base, id: 'city', districtId: null, villageId: null }]);
    expect(await svc.resolve({ provinceId: null, cityId: null })).toBeNull();
  });
});

describe('DeliveryCoverageService.check', () => {
  it('reports DISABLED as not deliverable', async () => {
    const svc = makeService([{ ...base, id: 'x', districtId: null, villageId: null, coverageType: CoverageType.DISABLED }]);
    const res = await svc.check({ provinceId: 'P', cityId: 'C' });
    expect(res.deliverable).toBe(false);
    expect(res.pickupOnly).toBe(false);
    expect(res.coverageType).toBe(CoverageType.DISABLED);
  });

  it('reports PICKUP_ONLY correctly', async () => {
    const svc = makeService([{ ...base, id: 'x', districtId: null, villageId: null, coverageType: CoverageType.PICKUP_ONLY }]);
    const res = await svc.check({ provinceId: 'P', cityId: 'C' });
    expect(res.pickupOnly).toBe(true);
    expect(res.deliverable).toBe(false);
  });

  it('treats an unconfigured location as deliverable (legacy)', async () => {
    const svc = makeService([]);
    const res = await svc.check({ provinceId: 'P', cityId: 'C' });
    expect(res.configured).toBe(false);
    expect(res.deliverable).toBe(true);
    expect(res.coverageId).toBeNull();
  });

  it('returns fee/estimate for a DELIVERY rule', async () => {
    const svc = makeService([
      { ...base, id: 'x', districtId: null, villageId: null, deliveryFee: 10000, estimatedMinutes: 45 },
    ]);
    const res = await svc.check({ provinceId: 'P', cityId: 'C' });
    expect(res.deliverable).toBe(true);
    expect(res.deliveryFee).toBe(10000);
    expect(res.estimatedMinutes).toBe(45);
    expect(res.coverageId).toBe('x');
  });
});
