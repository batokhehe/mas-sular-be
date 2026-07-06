import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { randomInt } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { PAYMENT_UNIQUE_CODE_CONFIG, PaymentUniqueCodeConfig } from './payment-unique-code.config';

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
   * Allocate a collision-free unique code for a BANK_TRANSFER order whose amount
   * (before the code) is `baseAmount`. Returns null when the feature is disabled —
   * callers then keep the legacy amount unchanged. Draws random codes in
   * [min, max] and retries on collision; throws after `maxAttempts` exhausted.
   */
  async allocate(baseAmount: number): Promise<number | null> {
    if (!this.config.enabled) return null;

    const { min, max, maxAttempts } = this.config;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // Cryptographically random (never sequential). randomInt's upper bound is
      // exclusive → +1 to make `max` inclusive.
      const code = randomInt(min, max + 1);
      const finalAmount = baseAmount + code;

      const clash = await this.prisma.payment.findFirst({
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
