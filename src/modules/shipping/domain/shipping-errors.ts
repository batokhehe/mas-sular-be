/**
 * Error taxonomy for shipping-provider HTTP integrations.
 *
 *   Network timeout  → TransientError
 *   HTTP 5xx / 429   → TransientError  (retryable)
 *   HTTP 4xx         → PermanentError  (not retryable)
 */
export class ShippingProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Retryable failure — timeout, network error, or 5xx/429 from the courier. */
export class TransientError extends ShippingProviderError {}

/** Non-retryable failure — a 4xx from the courier (bad request, auth, not found). */
export class PermanentError extends ShippingProviderError {}
