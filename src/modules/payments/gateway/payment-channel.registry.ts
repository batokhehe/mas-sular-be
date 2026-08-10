import { Injectable, NotFoundException } from '@nestjs/common';
import {
  PAYMENT_CHANNELS,
  PaymentChannelCode,
  PaymentChannelDescriptor,
  PublicPaymentChannel,
  toPublicChannel,
} from './domain/payment-channel';
import { PaymentProvider } from './domain/payment-provider.interface';
import { PaymentProviderFactory } from './payment-provider.factory';

/**
 * The channel catalog and the channel → provider binding.
 *
 * A channel is AVAILABLE only when it is statically enabled AND its provider is
 * registered in this build AND that provider declares support for it. That triple
 * gate is why Phase 1 is inert: no gateway provider exists yet, so only manual
 * transfer can ever be returned — exactly today's customer-visible behavior.
 */
@Injectable()
export class PaymentChannelRegistry {
  constructor(private readonly providers: PaymentProviderFactory) {}

  /** Every catalog entry, including unavailable ones (diagnostics / admin). */
  list(): PaymentChannelDescriptor[] {
    return [...PAYMENT_CHANNELS];
  }

  /** Catalog entries a customer may actually choose right now. */
  listAvailable(): PaymentChannelDescriptor[] {
    return PAYMENT_CHANNELS.filter((channel) => this.isAvailable(channel));
  }

  /** Customer-facing projection of `listAvailable()` — provider names stripped. */
  listPublic(): PublicPaymentChannel[] {
    return this.listAvailable().map(toPublicChannel);
  }

  find(code: string): PaymentChannelDescriptor | undefined {
    return PAYMENT_CHANNELS.find((channel) => channel.code === code);
  }

  isAvailable(channel: PaymentChannelDescriptor): boolean {
    if (!channel.enabled) return false;
    const provider = this.providers.get(channel.provider);
    return Boolean(provider?.supportedChannels().includes(channel.code));
  }

  /**
   * Resolve a channel code to its descriptor + live provider. Throws 404 for an
   * unknown or unavailable channel so a client can never drive an unwired gateway.
   */
  resolve(code: string): { channel: PaymentChannelDescriptor; provider: PaymentProvider } {
    const channel = this.find(code);
    if (!channel || !this.isAvailable(channel)) {
      throw new NotFoundException(`Payment channel '${code}' is not available`);
    }
    // isAvailable() already proved the provider is registered.
    return { channel, provider: this.providers.get(channel.provider)! };
  }

  /** Convenience for callers holding a typed code. */
  resolveCode(code: PaymentChannelCode) {
    return this.resolve(code);
  }
}
