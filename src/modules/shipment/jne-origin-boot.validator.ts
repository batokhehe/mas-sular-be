import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { loadShippingConfig } from '../shipping/shipping.config';

/**
 * PAXELBOX-61P: check JNE_ORIGIN_CODE against JNE's own ORIGIN master.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `JNE_ORIGIN_CODE` was `BDO10056` for months and passed every check the
 * application had, because the only check was "non-empty". PAXELBOX-61L proved
 * BDO10056 is a DESTINATION code — "MARGACINTA,BANDUNG" — and is absent from the
 * origin master entirely. It would have been sent to JNE as `origin_code` on the
 * first native booking.
 *
 * A regex cannot catch that: BDO10056 matches JNE's code shape perfectly. Only
 * the master distinguishes an origin from a destination, so only the master can
 * validate one.
 *
 * ---------------------------------------------------------------------------
 * WHY AT BOOTSTRAP AND NOT IN env.validation
 *
 * env.validation is env-only and has no database. This mirrors
 * OutletBootValidator, which exists for the same reason: the fact being checked
 * lives in a table, so the check runs where a Prisma round-trip is available.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES *NOT* DO
 *
 * When the origin master has not been imported yet, this WARNS and allows boot.
 * That is deliberate, and it is the one case worth arguing about:
 *
 *   - migration 20260901000000 is knowingly unapplied, so `JneLocation` may not
 *     exist at all; throwing would refuse to start an application whose JNE
 *     origin code is currently unused (`supportsAutomaticBooking = false`);
 *   - "the master is absent" is not evidence that the code is wrong. Refusing to
 *     boot would state something this validator has not established.
 *
 * It never passes silently: an empty master is logged as a warning saying the
 * check could not run. Once ORIGIN rows exist, a wrong code is a hard failure.
 * If you would rather an un-imported master block startup, that is a one-line
 * change here — and worth making once the migrations are applied.
 */
@Injectable()
export class JneOriginBootValidator implements OnApplicationBootstrap {
  private readonly logger = new Logger('JneOriginBootValidator');

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.validate(loadShippingConfig().jne);
  }

  /** Separated from the lifecycle hook so it is directly testable. */
  async validate(jne: { enabled: boolean; originCode?: string }): Promise<void> {
    // A disabled courier never sends an origin code anywhere.
    if (!jne.enabled) return;

    const code = jne.originCode?.trim();
    if (!code) {
      throw new Error('JNE_ENABLED=true but JNE_ORIGIN_CODE is not set.');
    }

    let originRows: number;
    let match: { isActive: boolean } | null;
    try {
      // Counted, not assumed: an empty master means "cannot check", which is a
      // different answer from "the code is wrong", and the two must not merge.
      originRows = await this.prisma.jneLocation.count({ where: { kind: 'ORIGIN' } });
      match = await this.prisma.jneLocation.findFirst({
        where: { code, kind: 'ORIGIN' },
        select: { isActive: true },
      });
    } catch (err) {
      // The table does not exist yet (migration 20260901000000 is unapplied).
      const message = err instanceof Error ? err.message : String(err);
      if (/JneLocation|does not exist|doesn't exist|Unknown table|P2021/i.test(message)) {
        this.logger.warn(
          `JNE_ORIGIN_CODE could not be validated: the JneLocation table does not exist ` +
            `(migration 20260901000000_add_jne_master_data is unapplied). The configured origin ` +
            `code is UNVERIFIED.`,
        );
        return;
      }
      throw err;
    }

    if (originRows === 0) {
      this.logger.warn(
        `JNE_ORIGIN_CODE could not be validated: no JneLocation rows with kind=ORIGIN have been ` +
          `imported. Run prisma/tools/import-jne-master.ts --kind ORIGIN. The configured origin ` +
          `code is UNVERIFIED.`,
      );
      return;
    }

    if (!match) {
      throw new Error(
        `JNE_ORIGIN_CODE "${code}" is not a JNE origin code. It does not appear in the ` +
          `${originRows}-row JNE origin master. A destination code is not interchangeable with an ` +
          `origin code, and matching JNE's code format does not make one valid.`,
      );
    }
    if (!match.isActive) {
      throw new Error(
        `JNE_ORIGIN_CODE "${code}" exists in the JNE origin master but is INACTIVE, so JNE no ` +
          `longer serves it as an origin.`,
      );
    }

    this.logger.log(`JNE origin code "${code}" verified against the JNE origin master.`);
  }
}
