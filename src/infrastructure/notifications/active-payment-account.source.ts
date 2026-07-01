/**
 * Narrow port (interface segregation): the notification builder only needs the
 * single active payment account, never the full PaymentAccount CRUD surface.
 * PaymentAccountService implements this; the builder depends on the token only.
 */
export const ACTIVE_PAYMENT_ACCOUNT_SOURCE = 'ACTIVE_PAYMENT_ACCOUNT_SOURCE';

export interface ActivePaymentAccount {
  id: string;
  bankName: string;
  bankCode: string | null;
  accountName: string;
  accountNumber: string;
}

export interface ActivePaymentAccountSource {
  /** Returns the single active account, or throws ConfigurationError if none. */
  getActiveAccount(): Promise<ActivePaymentAccount>;
}
