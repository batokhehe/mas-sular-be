import { NotFoundException } from '@nestjs/common';
import { UsersController } from '../../src/modules/users/presentation/users.controller';

const USER = { sub: 'user-1', email: 'a@b.com', roles: [] } as const;

function buildTx() {
  return {
    address: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({ id: 'addr-1', isDefault: true }),
    },
  };
}

function build(owned: unknown = { id: 'addr-1' }, deleteCount = 1) {
  const tx = buildTx();
  const prisma = {
    address: {
      findFirst: jest.fn().mockResolvedValue(owned),
      updateMany: jest.fn().mockResolvedValue({ count: deleteCount }),
    },
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controller = new UsersController(prisma as any);
  return { controller, prisma, tx }
}

describe('UsersController — address update/delete', () => {
  describe('updateAddress', () => {
    it('updates an owned address and unsets the previous default when isDefault=true', async () => {
      const { controller, prisma, tx } = build()

      await controller.updateAddress(USER as any, 'addr-1', { label: 'Home', isDefault: true } as any)

      expect(prisma.address.findFirst).toHaveBeenCalledWith({
        where: { id: 'addr-1', userId: 'user-1', deletedAt: null },
        select: { id: true },
      })
      expect(tx.address.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', isDefault: true },
        data: { isDefault: false },
      })
      expect(tx.address.update).toHaveBeenCalledWith({
        where: { id: 'addr-1' },
        data: expect.objectContaining({ label: 'Home', isDefault: true }),
      })
    })

    it('does not unset defaults when isDefault is not set', async () => {
      const { controller, tx } = build()
      await controller.updateAddress(USER as any, 'addr-1', { phone: '0812345678' } as any)
      expect(tx.address.updateMany).not.toHaveBeenCalled()
    })

    it('404s when the address is not owned by the caller', async () => {
      const { controller, prisma } = build(null)
      await expect(controller.updateAddress(USER as any, 'addr-x', {} as any)).rejects.toBeInstanceOf(NotFoundException)
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })
  })

  describe('deleteAddress', () => {
    it('soft-deletes an owned address', async () => {
      const { controller, prisma } = build()
      const res = await controller.deleteAddress(USER as any, 'addr-1')
      expect(prisma.address.updateMany).toHaveBeenCalledWith({
        where: { id: 'addr-1', userId: 'user-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      })
      expect(res).toEqual({ success: true })
    })

    it('404s when nothing was deleted (not owned / already gone)', async () => {
      const { controller } = build({ id: 'addr-1' }, 0)
      await expect(controller.deleteAddress(USER as any, 'addr-x')).rejects.toBeInstanceOf(NotFoundException)
    })
  })
})
