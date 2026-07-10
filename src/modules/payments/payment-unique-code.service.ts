import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { randomInt } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { PAYMENT_UNIQUE_CODE_CONFIG, PaymentUniqueCodeConfig } from './payment-unique-code.config';

/** Subset of the Prisma client the allocator needs — a tx client or the root client. */
type PaymentReader = Pick<PrismaService, 'payment'> | Prisma.TransactionClient;

/**
 * Allocates the manual BANK_TRANSFER "unique code" — a random 3-digit surcharge
 * folded into the transfer total so finance can match incoming transfers by amount.
 *
 * Uniqueness is scoped to *active* transfers only: the final amount (baseAmount +
 * code) must not collide with any other PENDING BANK_TRANSFER payment. Completed /
 * failed / expired payments are ignored, so codes are freely reused over time.
 */
@Injectable()
export class PaymentUniqueCodeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_UNIQUE_CODE_CONFIG) private readonly config: PaymentUniqueCodeConfig,
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * C4: transactional allocation — the collision re-check runs on the CALLER's
   * checkout transaction immediately before the payment row is created, closing
   * the pre-transaction check-then-act window (up to 10 attempts). Concurrent
   * committed PENDING transfers with the same total are seen; the residual
   * window is two uncommitted transactions racing (accepted: no unique index by
   * requirement).
   */
  async allocateInTx(tx: Prisma.TransactionClient, baseAmount: number): Promise<number | null> {
    return this.draw(tx, baseAmount, Math.max(10, this.config.maxAttempts));
  }

  private async draw(client: PaymentReader, baseAmount: number, maxAttempts: number): Promise<number | null> {
    if (!this.config.enabled) return null;

    const { min, max } = this.config;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // Cryptographically random (never sequential). randomInt's upper bound is
      // exclusive → +1 to make `max` inclusive.
      const code = randomInt(min, max + 1);
      const finalAmount = baseAmount + code;

      const clash = await client.payment.findFirst({
        where: {
          method: PaymentMethod.BANK_TRANSFER,
          status: PaymentStatus.PENDING,
          amount: finalAmount,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!clash) return code;
    }

    throw new ConflictException('Unable to allocate a unique payment code; please try again');
  }
}
