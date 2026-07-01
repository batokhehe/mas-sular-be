import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ConfigurationError } from '../../common/errors/configuration.error';
import {
  ActivePaymentAccount,
  ActivePaymentAccountSource,
} from '../../infrastructure/notifications/active-payment-account.source';
import { CreatePaymentAccountDto } from './application/dto/create-payment-account.dto';
import { UpdatePaymentAccountDto } from './application/dto/update-payment-account.dto';

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value ? (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue) : undefined;
}

@Injectable()
export class PaymentAccountService implements ActivePaymentAccountSource {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.paymentAccount.findMany({ orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] });
  }

  async getById(id: string) {
    const account = await this.prisma.paymentAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException('Payment account not found');
    return account;
  }

  /** ActivePaymentAccountSource: the single active account, or ConfigurationError (non-retryable). */
  async getActiveAccount(): Promise<ActivePaymentAccount> {
    const a = await this.prisma.paymentAccount.findFirst({ where: { isActive: true } });
    if (!a) throw new ConfigurationError('No active payment account configured');
    return {
      id: a.id,
      bankName: a.bankName,
      bankCode: a.bankCode,
      accountName: a.accountName,
      accountNumber: a.accountNumber,
    };
  }

  async create(dto: CreatePaymentAccountDto) {
    const created = await this.prisma.paymentAccount
      .create({ data: { ...dto, isActive: false } })
      .catch(rethrowUnique);
    await this.audit('create', created.id, null, created);
    return created;
  }

  async update(id: string, dto: UpdatePaymentAccountDto) {
    const before = await this.getById(id);
    const updated = await this.prisma.paymentAccount
      .update({ where: { id }, data: { ...dto } })
      .catch(rethrowUnique);
    await this.audit('update', id, before, updated);
    return updated;
  }

  /** Exactly-one-active invariant: deactivate all others, then activate this one (one tx). */
  async activate(id: string) {
    const before = await this.getById(id);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.paymentAccount.updateMany({ where: { isActive: true, NOT: { id } }, data: { isActive: false } });
      return tx.paymentAccount.update({ where: { id }, data: { isActive: true } });
    });
    await this.audit('activate', id, before, updated);
    return updated;
  }

  async remove(id: string) {
    const before = await this.getById(id);
    if (before.isActive) throw new ConflictException('Cannot delete the active payment account');
    await this.prisma.paymentAccount.delete({ where: { id } });
    await this.audit('delete', id, before, null);
    return { success: true };
  }

  /**
   * Audit financial-config changes. actorId is left null: admins live in a separate
   * `admin` table while AuditLog.actorId FKs to `User`; the before/after snapshots and
   * action capture the change. (Admin-actor attribution is a known schema limitation.)
   */
  private async audit(op: string, entityId: string, before: unknown, after: unknown): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          action: `paymentAccount.${op}`,
          entity: 'PaymentAccount',
          entityId,
          before: toJson(before),
          after: toJson(after),
        },
      })
      .catch(() => undefined);
  }
}

function rethrowUnique(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ConflictException('Account number already exists');
  }
  throw err instanceof Error ? err : new Error(String(err));
}
