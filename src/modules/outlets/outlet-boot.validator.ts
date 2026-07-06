import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { loadShippingConfig } from '../shipping/shipping.config';

/**
 * Fail-fast at boot: if any shipping provider is enabled, an active outlet MUST
 * exist (shipping providers always use the active outlet as the origin). Runs on
 * application bootstrap because it needs a DB round-trip (env.validation is
 * env-only and cannot check this).
 */
@Injectable()
export class OutletBootValidator implements OnApplicationBootstrap {
  private readonly logger = new Logger('OutletBootValidator');

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    const config = loadShippingConfig();
    const anyProviderEnabled = config.paxel.enabled || config.jne.enabled;
    if (!anyProviderEnabled) return;

    const activeCount = await this.prisma.outlet.count({ where: { isActive: true } });
    if (activeCount === 0) {
      throw new Error(
        'A shipping provider is enabled (PAXEL_ENABLED/JNE_ENABLED) but no active outlet is configured. ' +
          'Configure and activate an outlet before enabling shipping providers.',
      );
    }
    this.logger.log('Active outlet present; shipping origin configuration OK.');
  }
}
