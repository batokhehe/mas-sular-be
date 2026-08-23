import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminService } from '../../src/modules/admin/admin.service';

/**
 * Regression for C7b.
 *
 * updateRole replaces the role's permission set wholesale. Before this, the write was
 * unconditional (`where: { id }`), so two administrators who opened the same role both
 * saved successfully and the second silently discarded the first's change — reproduced
 * against a real database, not hypothesised. The dangerous direction is that a stale
 * set can also resurrect a permission somebody just revoked.
 *
 * The guard is a compare-and-swap on `updatedAt`, evaluated in the write itself. These
 * tests pin both halves: the CAS predicate is actually sent, and a failed CAS touches
 * no permission rows.
 */

const T1 = '2026-08-21T08:16:26.273Z'; // what both writers read
const T2 = '2026-08-21T08:16:31.918Z'; // what the row holds after the first writer

interface Calls {
  updateMany: jest.Mock;
  deleteMany: jest.Mock;
  createMany: jest.Mock;
  findUniqueOrThrow: jest.Mock;
}

/** @param claimed rows matched by the CAS: 1 = won, 0 = someone else got there first. */
function build(claimed: number, roleExists = true) {
  const calls: Calls = {
    updateMany: jest.fn().mockResolvedValue({ count: claimed }),
    deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
    createMany: jest.fn().mockResolvedValue({ count: 3 }),
    findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'role-tgt', name: 'ADMIN', permissions: [] }),
  };
  const tx = {
    role: { updateMany: calls.updateMany, findUniqueOrThrow: calls.findUniqueOrThrow },
    rolePermission: { deleteMany: calls.deleteMany, createMany: calls.createMany },
  };
  const prisma = {
    // getRole()'s 404 guard
    role: { findUnique: jest.fn().mockResolvedValue(roleExists ? { id: 'role-tgt', permissions: [] } : null) },
    // Interactive form: hand the callback our tx stub and let it run for real.
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AdminService(prisma as any, {} as any);
  return { service, calls, prisma };
}

describe('AdminService.updateRole — optimistic concurrency (C7b)', () => {
  it('1. a normal update succeeds when the CAS matches', async () => {
    const { service, calls } = build(1);
    const role = await service.updateRole('role-tgt', { name: 'ADMIN', expectedUpdatedAt: T1 });
    expect(role).toEqual({ id: 'role-tgt', name: 'ADMIN', permissions: [] });
    expect(calls.updateMany).toHaveBeenCalledTimes(1);
  });

  it('2. expectedUpdatedAt is sent as the CAS predicate, as a Date', async () => {
    const { service, calls } = build(1);
    await service.updateRole('role-tgt', { expectedUpdatedAt: T1, permissionIds: ['p1'] });
    const where = calls.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe('role-tgt');
    expect(where.updatedAt).toBeInstanceOf(Date);
    expect((where.updatedAt as Date).toISOString()).toBe(T1);
  });

  it('3. a stale expectedUpdatedAt raises ConflictException', async () => {
    const { service } = build(0); // the row moved on; nothing matched
    await expect(
      service.updateRole('role-tgt', { expectedUpdatedAt: T1, permissionIds: ['p1'] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('4. the conflict message is stable and leaks nothing', async () => {
    const { service } = build(0);
    await expect(service.updateRole('role-tgt', { expectedUpdatedAt: T1 })).rejects.toThrow(
      'Role was modified by another administrator. Please reload and retry.',
    );
  });

  it('5. a successful update bumps updatedAt (so the next stale token cannot match)', async () => {
    const { service, calls } = build(1);
    const before = Date.now();
    await service.updateRole('role-tgt', { expectedUpdatedAt: T1, permissionIds: ['p1'] });
    const written = calls.updateMany.mock.calls[0][0].data.updatedAt as Date;
    expect(written).toBeInstanceOf(Date);
    expect(written.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('6. a stale update deletes NO permissions', async () => {
    const { service, calls } = build(0);
    await expect(
      service.updateRole('role-tgt', { expectedUpdatedAt: T1, permissionIds: ['p1', 'p2'] }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(calls.deleteMany).not.toHaveBeenCalled();
  });

  it('7. a stale update creates NO permissions', async () => {
    const { service, calls } = build(0);
    await expect(
      service.updateRole('role-tgt', { expectedUpdatedAt: T1, permissionIds: ['p1', 'p2'] }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(calls.createMany).not.toHaveBeenCalled();
  });

  it('8. replacement runs inside ONE transaction, CAS before any delete', async () => {
    const { service, calls, prisma } = build(1);
    const order: string[] = [];
    calls.updateMany.mockImplementation(async () => {
      order.push('cas');
      return { count: 1 };
    });
    calls.deleteMany.mockImplementation(async () => {
      order.push('delete');
      return { count: 2 };
    });
    calls.createMany.mockImplementation(async () => {
      order.push('create');
      return { count: 2 };
    });

    await service.updateRole('role-tgt', { expectedUpdatedAt: T1, permissionIds: ['p1', 'p2'] });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['cas', 'delete', 'create']);
  });

  it('9. a retry with the fresh updatedAt succeeds', async () => {
    const stale = build(0);
    await expect(stale.service.updateRole('role-tgt', { expectedUpdatedAt: T1 })).rejects.toBeInstanceOf(
      ConflictException,
    );
    const retry = build(1);
    await expect(retry.service.updateRole('role-tgt', { expectedUpdatedAt: T2 })).resolves.toBeDefined();
    expect((retry.calls.updateMany.mock.calls[0][0].where.updatedAt as Date).toISOString()).toBe(T2);
  });

  it('10. an unrelated role is scoped by its own id', async () => {
    const { service, calls } = build(1);
    await service.updateRole('role-other', { expectedUpdatedAt: T1, permissionIds: ['p9'] });
    expect(calls.updateMany.mock.calls[0][0].where.id).toBe('role-other');
    expect(calls.deleteMany.mock.calls[0][0].where.roleId).toBe('role-other');
  });

  it('11. clearing every permission is allowed and skips the insert', async () => {
    const { service, calls } = build(1);
    await service.updateRole('role-tgt', { expectedUpdatedAt: T1, permissionIds: [] });
    expect(calls.deleteMany).toHaveBeenCalledTimes(1);
    expect(calls.createMany).not.toHaveBeenCalled();
  });

  it('12. a name/description-only edit is protected by the same CAS', async () => {
    const { service, calls } = build(0);
    await expect(
      service.updateRole('role-tgt', { expectedUpdatedAt: T1, description: 'renamed' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(calls.updateMany).toHaveBeenCalledTimes(1);
  });

  it('13. a missing role still 404s before any CAS is attempted', async () => {
    const { service, calls } = build(1, false);
    await expect(service.updateRole('nope', { expectedUpdatedAt: T1 })).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.updateMany).not.toHaveBeenCalled();
  });
});
