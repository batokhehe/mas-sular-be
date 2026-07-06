import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminOrderNotesService } from '../../src/modules/admin/admin-order-notes.service';

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    order: { findFirst: jest.fn().mockResolvedValue({ id: 'o1' }) },
    orderNote: {
      findMany: jest.fn().mockResolvedValue([{ id: 'n1', body: 'hi' }]),
      create: jest.fn().mockImplementation(async ({ data }: { data: unknown }) => ({ id: 'n-new', ...(data as object) })),
      update: jest.fn().mockImplementation(async ({ data }: { data: unknown }) => ({ id: 'n1', ...(data as object) })),
      delete: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ id: 'n1', orderId: 'o1', adminId: 'admin1', body: 'old' }),
    },
    ...overrides,
  };
}

function svc(prisma = buildPrisma()) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service: new AdminOrderNotesService(prisma as any), prisma };
}

const ADMIN = { id: 'admin1', name: 'Admin One' };

describe('AdminOrderNotesService', () => {
  it('create: stores author snapshot + trimmed body', async () => {
    const { service, prisma } = svc();
    const note = await service.create('o1', ADMIN, { body: '  needs follow-up  ' });
    expect(prisma.orderNote.create).toHaveBeenCalledWith({
      data: { orderId: 'o1', adminId: 'admin1', adminName: 'Admin One', body: 'needs follow-up' },
    });
    expect(note).toMatchObject({ adminName: 'Admin One' });
  });

  it('list: newest first for the order', async () => {
    const { service, prisma } = svc();
    await service.list('o1');
    expect(prisma.orderNote.findMany).toHaveBeenCalledWith({ where: { orderId: 'o1' }, orderBy: { createdAt: 'desc' } });
  });

  it('update: author can edit', async () => {
    const { service, prisma } = svc();
    await service.update('o1', 'n1', 'admin1', { body: 'updated' });
    expect(prisma.orderNote.update).toHaveBeenCalledWith({ where: { id: 'n1' }, data: { body: 'updated' } });
  });

  it('update: a different admin is forbidden', async () => {
    const { service, prisma } = svc();
    await expect(service.update('o1', 'n1', 'other-admin', { body: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.orderNote.update).not.toHaveBeenCalled();
  });

  it('delete: author can delete; others cannot', async () => {
    const { service, prisma } = svc();
    await expect(service.remove('o1', 'n1', 'admin1')).resolves.toEqual({ deleted: true });
    await expect(service.remove('o1', 'n1', 'other')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.orderNote.delete).toHaveBeenCalledTimes(1);
  });

  it('404 when the note does not belong to the order', async () => {
    const prisma = buildPrisma({ orderNote: { ...buildPrisma().orderNote, findUnique: jest.fn().mockResolvedValue({ id: 'n1', orderId: 'other', adminId: 'admin1' }) } });
    const { service } = svc(prisma);
    await expect(service.update('o1', 'n1', 'admin1', { body: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 when the order does not exist', async () => {
    const prisma = buildPrisma({ order: { findFirst: jest.fn().mockResolvedValue(null) } });
    const { service } = svc(prisma);
    await expect(service.list('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
