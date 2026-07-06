import { Inject, Injectable } from '@nestjs/common';
import { ShippingProvider } from './domain/shipping-provider.interface';

/** DI token for the array of registered shipping couriers. Add a new courier by
 *  appending it to the `useFactory` list in ShippingModule — nothing else changes. */
export const SHIPPING_PROVIDERS = Symbol('SHIPPING_PROVIDERS');

/**
 * Factory/registry over all shipping couriers. The checkout depends only on this
 * (via ShippingService), so adding J&T / SiCepat / Anteraja / POS Indonesia never
 * requires touching CheckoutService or OrdersService.
 */
@Injectable()
export class ShippingProviderFactory {
  private readonly registry = new Map<string, ShippingProvider>();

  constructor(@Inject(SHIPPING_PROVIDERS) providers: ShippingProvider[]) {
    for (const provider of providers) {
      this.registry.set(provider.name, provider);
    }
  }

  getAll(): ShippingProvider[] {
    return [...this.registry.values()];
  }

  get(name: string): ShippingProvider | undefined {
    return this.registry.get(name);
  }
}
