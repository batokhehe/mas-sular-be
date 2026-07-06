import { Inject, Injectable } from '@nestjs/common';
import { ShipmentProvider } from './domain/shipment-provider.interface';

/** DI token for the array of registered fulfillment couriers. Add a courier by
 *  appending it to the `useFactory` list in ShipmentModule — nothing else changes. */
export const SHIPMENT_PROVIDERS = Symbol('SHIPMENT_PROVIDERS');

/**
 * Factory/registry over all shipment (fulfillment) couriers. Mirrors the quotation
 * ShippingProviderFactory but is a separate concern — quotation providers are
 * untouched.
 */
@Injectable()
export class ShipmentProviderFactory {
  private readonly registry = new Map<string, ShipmentProvider>();

  constructor(@Inject(SHIPMENT_PROVIDERS) providers: ShipmentProvider[]) {
    for (const provider of providers) {
      this.registry.set(provider.name, provider);
    }
  }

  getAll(): ShipmentProvider[] {
    return [...this.registry.values()];
  }

  get(name: string): ShipmentProvider | undefined {
    return this.registry.get(name);
  }
}
