import { Injectable, Logger } from '@nestjs/common';
import { NotificationDraft } from './admin-notification.builder';
import { AdminNotificationMetrics } from './admin-notification.metrics';
import { AdminNotificationRepository } from './admin-notification.repository';
import { FirebasePushChannel } from './push.channel';
import { SseHubService } from './sse-hub.service';

/** Channel abstraction — future channels (Email/WhatsApp/Slack/Discord) plug in here. */
export interface AdminNotificationChannel {
  name: string;
  dispatch(draft: NotificationDraft, adminIds: string[]): Promise<void>;
}

/**
 * Orchestrates delivery: persist (database channel, fan-out per admin) FIRST —
 * it is the source of truth — then realtime channels (SSE, push). Channel
 * failures are isolated: one broken channel never blocks the others.
 */
@Injectable()
export class AdminNotificationDispatcher {
  private readonly logger = new Logger('AdminNotificationDispatcher');
  private readonly realtimeChannels: AdminNotificationChannel[];

  constructor(
    private readonly repository: AdminNotificationRepository,
    private readonly sseHub: SseHubService,
    private readonly push: FirebasePushChannel,
    private readonly metrics: AdminNotificationMetrics,
  ) {
    this.realtimeChannels = [
      {
        name: 'sse',
        dispatch: async (draft, adminIds) => {
          this.sseHub.broadcast(adminIds, 'notification.created', draft);
          this.sseHub.broadcast(adminIds, 'counter.updated', { delta: 1 });
        },
      },
      { name: this.push.name, dispatch: (draft, adminIds) => this.push.dispatch(draft, adminIds) },
    ];
  }

  /** Deliver a built draft to the target admins (null → every active admin). */
  async dispatch(draft: NotificationDraft, targetAdminIds: string[] | null = null): Promise<number> {
    const startedAt = Date.now();
    const adminIds = targetAdminIds ?? (await this.repository.activeAdminIds());
    if (adminIds.length === 0) return 0;

    // 1. Database channel (source of truth) — must succeed.
    const created = await this.repository.createForAdmins(draft, adminIds);
    this.metrics.created(created);

    // 2. Realtime channels — isolated, best-effort.
    for (const channel of this.realtimeChannels) {
      try {
        await channel.dispatch(draft, adminIds);
      } catch (err) {
        this.logger.warn(`channel ${channel.name} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.metrics.observeProcessing(Date.now() - startedAt);
    return created;
  }

  /** Realtime read-state sync (multi-tab badge consistency). */
  notifyRead(adminId: string, notificationId: string | 'all'): void {
    this.sseHub.broadcast([adminId], 'notification.read', { id: notificationId });
    this.sseHub.broadcast([adminId], 'counter.updated', { delta: 0 });
  }
}
