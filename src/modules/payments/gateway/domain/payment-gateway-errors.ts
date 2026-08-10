/**
 * Error taxonomy for payment-gateway HTTP integrations. Mirrors the shipping
 * taxonomy so callers classify failures the same way everywhere.
 *
 *   Network / timeout        → TransientGatewayError (retryable)
 *   HTTP 429, 500, 502-504   → TransientGatewayError (retryable)
 *   Any other 4xx / bad body → PermanentGatewayError (never retried — a retry
 *                              would only repeat a rejected charge)
 */
export class PaymentGatewayError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class TransientGatewayError extends PaymentGatewayError {}

export class PermanentGatewayError extends PaymentGatewayError {}
