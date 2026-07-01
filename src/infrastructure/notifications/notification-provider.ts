import { NotificationMessage } from './notification-message';

export interface NotificationSendResult {
  providerMessageId: string;
}

/** Do NOT retry — bad recipient/template/channel (provider 4xx-class). */
export class PermanentSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSendError';
  }
}

/** Retry with backoff — network/provider 5xx/timeout/rate-limit. */
export class TransientSendError extends Error {
  /** Optional provider-suggested delay (from a 429 Retry-After) honored by the sender. */
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TransientSendError';
  }
}

export interface NotificationProvider {
  readonly channel: string;
  /** Transport only: map the channel-agnostic message to the provider API and send. */
  send(message: NotificationMessage): Promise<NotificationSendResult>;
}
