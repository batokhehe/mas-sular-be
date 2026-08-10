import { Inject, Injectable } from '@nestjs/common';
import { PaymentProvider } from './domain/payment-provider.interface';

/** DI token for the array of registered payment providers. Add a new gateway by
 *  appending it to the `useFactory` list in PaymentGatewayModule — nothing else changes. */
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');

/**
 * Factory/registry over all payment providers. Business services depend only on
 * PaymentInitiationService (which depends on this), so adding Midtrans / Xendit /
 * DOKU / Tripay never requires touching OrdersService or the checkout.
 * Deliberately identical in shape to ShippingProviderFactory.
 */
@Injectable()
export class PaymentProviderFactory {
  private readonly registry = new Map<string, PaymentProvider>();

  constructor(@Inject(PAYMENT_PROVIDERS) providers: PaymentProvider[]) {
    for (const provider of providers) {
      this.registry.set(provider.name, provider);
    }
  }

  getAll(): PaymentProvider[] {
    return [...this.registry.values()];
  }

  get(name: string): PaymentProvider | undefined {
    return this.registry.get(name);
  }

  /** Whether a provider is wired in this build — used to gate channel availability. */
  has(name: string): boolean {
    return this.registry.has(name);
  }
}
