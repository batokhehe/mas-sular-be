import { ConflictException, NotFoundException } from '@nestjs/common';
import { OutletService } from '../../src/modules/outlets/outlet.service';

function buildPrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    outlet: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({ id: 'o1', isActive: true }),
    },
  };
  return {
    outlet: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
      ...overrides,
    },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
}

describe('OutletService', () => {
  it('getActive returns the active outlet origin (numeric coordinates) or null', async () => {
    const prisma = buildPrisma({
      findFirst: jest.fn().mockResolvedValue({
        id: 'o1',
        name: 'Pusat',
        postalCode: '40111',
        latitude: '-6.9147000',
        longitude: '107.6098000',
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new OutletService(prisma as any);
    const active = await service.getActive();
    expect(active).toEqual({ id: 'o1', name: 'Pusat', postalCode: '40111', latitude: -6.9147, longitude: 107.6098 });

    const empty = new OutletService(buildPrisma({ findFirst: jest.fn().mockResolvedValue(null) }) as any);
    expect(await empty.getActive()).toBeNull();
  });

  it('activate deactivates every other outlet then activates this one (one tx)', async () => {
    const prisma = buildPrisma({ findUnique: jest.fn().mockResolvedValue({ id: 'o1' }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new OutletService(prisma as any);
    await service.activate('o1');
    expect(prisma.__tx.outlet.updateMany).toHaveBeenCalledWith({
      where: { isActive: true, NOT: { id: 'o1' } },
      data: { isActive: false },
    });
    expect(prisma.__tx.outlet.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1' }, data: { isActive: true } }),
    );
  });

  it('refuses to delete the active outlet', async () => {
    const prisma = buildPrisma({ findUnique: jest.fn().mockResolvedValue({ id: 'o1', isActive: true }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new OutletService(prisma as any);
    await expect(service.remove('o1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws NotFound for a missing outlet', async () => {
    const prisma = buildPrisma({ findUnique: jest.fn().mockResolvedValue(null) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new OutletService(prisma as any);
    await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
