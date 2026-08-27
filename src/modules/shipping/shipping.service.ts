import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ShippingQuote, ShippingRate, ShippingRateRequest } from './domain/shipping-provider.interface';
import { ShippingProviderFactory } from './shipping-provider.factory';

@Injectable()
export class ShippingService {
  constructor(private readonly factory: ShippingProviderFactory) {}

  /**
   * Every service offered by every registered courier for the request. This is what
   * checkout displays and what the customer selects from.
   */
  async getQuotes(request: ShippingRateRequest): Promise<ShippingQuote[]> {
    const quotes = await Promise.all(this.factory.getAll().map((provider) => provider.getRates(request)));
    return quotes.flat();
  }

  /**
   * Pick one selected service out of quotes that were ALREADY fetched for the
   * same request. Split out of findQuote so a caller holding those quotes can
   * reuse them instead of paying for a second courier round-trip; both paths
   * therefore raise the identical "unavailable" error from one place.
   */
  selectQuote(quotes: ShippingQuote[], provider: string, service: string): ShippingQuote {
    const match = quotes.find((q) => q.provider === provider && q.service === service);
    if (!match) throw new BadRequestException('Selected shipping service is unavailable');
    return match;
  }

  /** Resolve a specific selected quote (server-authoritative price). */
  async findQuote(request: ShippingRateRequest, provider: string, service: string): Promise<ShippingQuote> {
    return this.selectQuote(await this.getQuotes(request), provider, service);
  }

  /**
   * Legacy: one representative rate per courier (first service). Kept for the
   * /shipping/rates endpoint and the courier-based checkout fallback.
   */
  async calculateRates(request: ShippingRateRequest): Promise<ShippingRate[]> {
    const perProvider = await Promise.all(
      this.factory.getAll().map(async (provider) => {
        const [first] = await provider.getRates(request);
        return first ? toLegacyRate(first) : null;
      }),
    );
    return perProvider.filter((rate): rate is ShippingRate => rate !== null);
  }

  /** Legacy: the first quote for a named courier, in the legacy {cost, etd} shape. */
  async calculateRateForCourier(courier: string, request: ShippingRateRequest): Promise<ShippingRate> {
    const provider = this.factory.get(courier);
    if (!provider) throw new BadRequestException('Unsupported courier');
    const [first] = await provider.getRates(request);
    if (!first) throw new BadRequestException('Shipping rate is unavailable');
    return toLegacyRate(first);
  }

  async track(providerName: string, trackingNumber: string) {
    const provider = this.factory.get(providerName);
    if (!provider) throw new NotFoundException('Shipping provider not found');
    return provider.track(trackingNumber);
  }
}

function toLegacyRate(quote: ShippingQuote): ShippingRate {
  return { provider: quote.provider, service: quote.service, cost: quote.shippingCost, etd: quote.estimatedDays };
}
