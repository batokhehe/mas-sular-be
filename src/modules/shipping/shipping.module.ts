import { Module } from '@nestjs/common';
import { JneProvider } from './infrastructure/providers/jne.provider';
import { PaxelProvider } from './infrastructure/providers/paxel.provider';
import { ShippingController } from './presentation/shipping.controller';
import { ShippingService } from './shipping.service';
import { SHIPPING_PROVIDERS, ShippingProviderFactory } from './shipping-provider.factory';
import { SHIPPING_CONFIG, assertShippingConfigured, loadShippingConfig } from './shipping.config';

@Module({
  controllers: [ShippingController],
  providers: [
    {
      // Load provider config once and fail-fast when a provider is enabled but its
      // credentials are missing (belt-and-braces with env.validation at boot).
      provide: SHIPPING_CONFIG,
      useFactory: () => {
        const config = loadShippingConfig();
        assertShippingConfigured(config);
        return config;
      },
    },
    PaxelProvider,
    JneProvider,
    // === Courier registry ===
    // Add a new courier (J&T, SiCepat, Anteraja, POS Indonesia, …) by implementing
    // ShippingProvider and appending it to this list. Nothing downstream changes.
    {
      provide: SHIPPING_PROVIDERS,
      useFactory: (paxel: PaxelProvider, jne: JneProvider) => [paxel, jne],
      inject: [PaxelProvider, JneProvider],
    },
    ShippingProviderFactory,
    ShippingService,
  ],
  exports: [ShippingService],
})
export class ShippingModule {}
