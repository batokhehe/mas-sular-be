import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { NotificationDraft } from './admin-notification.builder';

export interface CursorListQuery {
  adminId: string;
  cursor?: string;
  limit?: number;
  unread?: boolean;
  category?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Persistence for admin notifications + push tokens. Notifications are FANNED
 * OUT on write (one row per target admin) so read state, badges, and cursors are
 * strictly per-admin with simple indexed queries.
 */
@Injectable()
export class AdminNotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** All active admin ids (broadcast targets). */
  async activeAdminIds(): Promise<string[]> {
    const admins = await this.prisma.admin.findMany({ where: { isActive: true }, select: { id: true } });
    return admins.map((a) => a.id);
  }

  /** Fan-out create: one row per admin. Returns the created ids per admin. */
  async createForAdmins(draft: NotificationDraft, adminIds: string[]): Promise<number> {
    if (adminIds.length === 0) return 0;
    const { count } = await this.prisma.notification.createMany({
      data: adminIds.map((adminId) => ({
        eventType: draft.eventType,
        category: draft.category,
        priority: draft.priority,
        title: draft.title.slice(0, 255),
        message: draft.message,
        url: draft.url,
        icon: draft.icon,
        metadata: (draft.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        adminId,
      })),
    });
    return count;
  }

  /** Cursor pagination (newest first) — for infinite scrolling. */
  async list(query: CursorListQuery) {
    const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
    const where: Prisma.NotificationWhereInput = {
      adminId: query.adminId,
      ...(query.unread ? { isRead: false } : {}),
      ...(query.category ? { category: query.category } : {}),
    };
    const rows = await this.prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // one extra row → does a next page exist?
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    });
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1]?.id ?? null : null };
  }

  unreadCount(adminId: string): Promise<number> {
    return this.prisma.notification.count({ where: { adminId, isRead: false } });
  }

  /** Ownership-scoped mark-read (idempotent). */
  async markRead(id: string, adminId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, adminId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    if (count === 0) {
      const exists = await this.prisma.notification.findFirst({ where: { id, adminId }, select: { id: true } });
      if (!exists) throw new NotFoundException('Notification not found');
    }
    return { read: true };
  }

  async markAllRead(adminId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { adminId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { read: count };
  }

  // ---------------- push tokens ----------------

  async registerPushToken(adminId: string, input: { token: string; browser?: string; platform?: string; device?: string; userAgent?: string }) {
    return this.prisma.pushSubscription.upsert({
      where: { adminId_token: { adminId, token: input.token } },
      update: { lastSeenAt: new Date(), browser: input.browser, platform: input.platform, device: input.device, userAgent: input.userAgent?.slice(0, 512) },
      create: {
        adminId,
        token: input.token,
        browser: input.browser,
        platform: input.platform,
        device: input.device,
        userAgent: input.userAgent?.slice(0, 512),
      },
    });
  }

  async removePushToken(adminId: string, token: string) {
    const { count } = await this.prisma.pushSubscription.deleteMany({ where: { adminId, token } });
    return { removed: count };
  }

  /** Invalid tokens reported by the push provider are purged everywhere. */
  async removeInvalidToken(token: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { token } });
  }

  tokensFor(adminIds: string[]) {
    return this.prisma.pushSubscription.findMany({ where: { adminId: { in: adminIds } }, select: { token: true, adminId: true } });
  }

  // ---------------- retention ----------------

  /**
   * P0-3: notifications are deleted in oldest-first LIMIT batches (same strategy
   * as the SystemLog/Outbox retention worker) — never one unbounded deleteMany.
   * Fan-out means rows = events × admins; the first sweep on a long-lived install
   * could otherwise delete millions of rows in a single locking statement.
   * Push tokens stay a plain deleteMany: bounded by admins × devices (tiny).
   */
  async cleanup(notificationRetentionDays: number, tokenStaleDays: number, batchSize = 1000) {
    const now = Date.now();
    const cutoff = new Date(now - notificationRetentionDays * 86_400_000);
    // Validated integer from our own config → injection-safe to inline in LIMIT;
    // the cutoff is parameterized (mirrors retention.worker.deleteBatch).
    const limit = Math.max(1, Math.trunc(batchSize));

    let notifications = 0;
    for (;;) {
      const affected = Number(
        await this.prisma.$executeRaw(
          Prisma.sql`DELETE FROM \`Notification\` WHERE \`createdAt\` < ${cutoff} ORDER BY \`createdAt\` ASC LIMIT ${Prisma.raw(String(limit))}`,
        ),
      );
      notifications += affected;
      if (affected < limit) break; // window drained
    }

    const tokens = await this.prisma.pushSubscription.deleteMany({
      where: { lastSeenAt: { lt: new Date(now - tokenStaleDays * 86_400_000) } },
    });
    return { notifications, tokens: tokens.count };
  }
}
