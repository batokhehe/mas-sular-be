import { Injectable, Logger } from '@nestjs/common';
import { AdminNotificationMetrics } from './admin-notification.metrics';
import { AdminNotificationRepository } from './admin-notification.repository';
import { NotificationDraft } from './admin-notification.builder';

export type PushSendResult = 'ok' | 'invalid-token' | 'transient';

/** Provider seam — the real FCM client OR a test double plugs in here. */
export interface PushProvider {
  send(token: string, payload: { title: string; body: string; url: string | null; icon: string | null }): Promise<PushSendResult>;
}

/**
 * Firebase Cloud Messaging channel. `firebase-admin` is loaded LAZILY and only
 * when FIREBASE_SERVICE_ACCOUNT_JSON is configured — without it the channel is a
 * structured-logged no-op, so the platform runs (DB + SSE) with push disabled.
 * Invalid tokens are purged automatically; transient failures get one retry.
 */
@Injectable()
export class FirebasePushChannel {
  readonly name = 'firebase-push';
  private readonly logger = new Logger('FirebasePushChannel');
  private provider: PushProvider | null | undefined; // undefined = not initialized yet

  constructor(
    private readonly repository: AdminNotificationRepository,
    private readonly metrics: AdminNotificationMetrics,
  ) {}

  /** Test seam. */
  setProvider(provider: PushProvider | null): void {
    this.provider = provider;
  }

  async dispatch(draft: NotificationDraft, adminIds: string[]): Promise<void> {
    const provider = this.resolveProvider();
    if (!provider) return; // push not configured — DB + SSE channels still deliver
    const subscriptions = await this.repository.tokensFor(adminIds);
    for (const sub of subscriptions) {
      await this.sendWithRetry(provider, sub.token, draft);
    }
  }

  private async sendWithRetry(provider: PushProvider, token: string, draft: NotificationDraft): Promise<void> {
    const payload = { title: draft.title, body: draft.message, url: draft.url, icon: draft.icon };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await provider.send(token, payload);
        if (result === 'ok') {
          this.metrics.pushSuccess();
          return;
        }
        if (result === 'invalid-token') {
          await this.repository.removeInvalidToken(token); // auto-purge dead tokens
          this.metrics.pushFailed();
          return;
        }
        // transient → retry once
      } catch {
        // network error → transient
      }
    }
    this.metrics.pushFailed();
  }

  /** Lazy, guarded firebase-admin bootstrap (never breaks the app when absent). */
  private resolveProvider(): PushProvider | null {
    if (this.provider !== undefined) return this.provider;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      this.logger.log('Web push disabled (FIREBASE_SERVICE_ACCOUNT_JSON not set)');
      this.provider = null;
      return null;
    }
    try {
      // Runtime require keeps firebase-admin an OPTIONAL dependency.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const firebase = require('firebase-admin') as {
        apps: unknown[];
        initializeApp(options: unknown): unknown;
        credential: { cert(json: unknown): unknown };
        messaging(): { send(message: unknown): Promise<string> };
      };
      if (firebase.apps.length === 0) {
        firebase.initializeApp({ credential: firebase.credential.cert(JSON.parse(raw)) });
      }
      this.provider = {
        send: async (token, payload) => {
          try {
            await firebase.messaging().send({
              token,
              notification: { title: payload.title, body: payload.body },
              data: { url: payload.url ?? '', icon: payload.icon ?? '' },
              webpush: { fcmOptions: payload.url ? { link: payload.url } : undefined },
            });
            return 'ok';
          } catch (err) {
            const code = (err as { code?: string })?.code ?? '';
            if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) return 'invalid-token';
            return 'transient';
          }
        },
      };
      this.logger.log('Web push enabled (Firebase Cloud Messaging)');
    } catch (err) {
      this.logger.warn(`firebase-admin unavailable — push disabled: ${err instanceof Error ? err.message : err}`);
      this.provider = null;
    }
    return this.provider;
  }
}
