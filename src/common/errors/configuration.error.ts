/**
 * Non-retryable misconfiguration (e.g. no active PaymentAccount, an unresolved
 * provider template). The notification sender treats this as terminal (FAILED),
 * never retrying — an operator must fix configuration and replay if needed.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}
