import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ShippingQuote, ShippingRate, ShippingRateRequest } from './domain/shipping-provider.interface';
import { ShippingProviderFactory } from './shipping-provider.factory';

@Injectable()
export class ShippingService {
  private readonly logger = new Logger('ShippingService');

  constructor(private readonly factory: ShippingProviderFactory) {}

  /**
   * Run every registered courier for one request and keep the couriers that
   * answered, ISOLATING the ones that did not.
   *
   * Why this exists: `Promise.all` rejects as soon as ANY provider rejects, so a
   * single courier being rate-limited or down removed every OTHER courier's
   * quotes from the checkout too — the customer saw no shipping options at all
   * (and, since ShippingProviderError is unmapped by the exceptions filter, a
   * 500) even though a perfectly good Paxel price had already been fetched.
   *
   * `allSettled` is the smallest change that fixes it: successful providers are
   * unaffected, and a failing one simply contributes nothing.
   *
   * Swallowing a provider's error here mirrors what PaxelProvider ALREADY does
   * between its own services (one unavailable service must not remove the
   * others) — this applies the same rule one level up, between couriers.
   *
   * When EVERY provider fails the error is re-thrown, preserving the previous
   * behaviour exactly: a total outage still surfaces as an error rather than as
   * a silent "no couriers available", and a programmer/configuration error that
   * breaks all providers is never disguised as an empty result. With no
   * providers registered at all this returns `[]`, as `Promise.all([])` did.
   */
  private async collectQuotes(request: ShippingRateRequest): Promise<ShippingQuote[][]> {
    const providers = this.factory.getAll();
    const settled = await Promise.allSettled(providers.map((provider) => provider.getRates(request)));

    const fulfilled: ShippingQuote[][] = [];
    const rejections: unknown[] = [];

    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        fulfilled.push(result.value);
        return;
      }
      rejections.push(result.reason);
      this.logger.warn({
        provider: providers[index]?.name ?? 'unknown',
        outcome: 'unavailable',
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    // Every provider failed — preserve the pre-existing "an error propagates"
    // contract. Rethrown in provider order rather than by which rejected first,
    // so the outcome is deterministic instead of a race.
    if (rejections.length > 0 && fulfilled.length === 0) throw rejections[0];

    return fulfilled;
  }

  /**
   * Every service offered by every registered courier for the request. This is what
   * checkout displays and what the customer selects from.
   */
  async getQuotes(request: ShippingRateRequest): Promise<ShippingQuote[]> {
    return (await this.collectQuotes(request)).flat();
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
    // Same isolation as getQuotes, via the same helper: this endpoint had the
    // identical Promise.all defect, so one failing courier emptied /shipping/rates.
    return (await this.collectQuotes(request))
      .map(([first]) => (first ? toLegacyRate(first) : null))
      .filter((rate): rate is ShippingRate => rate !== null);
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
