import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationChannel, NotificationOutbox, OrderStatus, Prisma, User } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { ConfigurationError } from '../../common/errors/configuration.error';
import { InvalidPhoneError, normalizePhoneNumber } from '../../common/utils/phone.util';
import { extractRelated } from '../../infrastructure/lifecycle/queue-center.util';
import { ManualTemplate, MANUAL_TEMPLATES } from '../../infrastructure/notifications/notification-message';
import { TemplateRegistry } from '../../infrastructure/notifications/template-registry';
import { TemplateRenderer } from '../../infrastructure/notifications/template-renderer';

const CONVERSATION_LIMIT = 200;
const COMPLETED_STATUSES: OrderStatus[] = [OrderStatus.COMPLETED, OrderStatus.DELIVERED];

const iso = (v: Date | null | undefined): string | null => (v ? v.toISOString() : null);

/** Variable hints per manual template (shown in the preview UI; NOT editable templates). */
export const MANUAL_TEMPLATE_VARIABLES: Record<ManualTemplate, string[]> = {
  'manual.order-update': ['customerName', 'orderNumber', 'message'],
  'manual.shipment-update': ['customerName', 'orderNumber', 'message'],
  'manual.custom': ['customerName', 'subject', 'message'],
};

export interface ManualSendInput {
  channel: NotificationChannel;
  recipient: string;
  template: ManualTemplate;
  message: string;
  customerName?: string;
  customerId?: string;
  orderId?: string;
  orderNumber?: string;
  subject?: string;
}

type CustomerSummary = { id: string; name: string; email: string; phone: string | null };

/**
 * Customer Communication Center — additive read/compose layer OVER the existing
 * NotificationOutbox pipeline. Reads join notifications to a customer; the only
 * write is a manual send that INSERTS a PENDING outbox row for the EXISTING
 * sender worker to deliver (never a direct provider call).
 */
@Injectable()
export class CustomerCommunicationService {
  private readonly logger = new Logger('CustomerCommunicationService');
  // Pure/env-only collaborators, same instantiation pattern as NotificationCenterService.
  private readonly renderer = new TemplateRenderer();
  private readonly registry = new TemplateRegistry();

  constructor(private readonly prisma: PrismaService) {}

  // ---------------- Conversation bundles ----------------

  /** Conversation + profile + metrics for the customer behind one notification. */
  async byNotification(notificationId: string) {
    const row = await this.prisma.notificationOutbox.findUnique({ where: { id: notificationId } });
    if (!row) throw new NotFoundException('Notification not found');
    const user = await this.resolveUser(row);
    return this.bundle(user, row.recipient);
  }

  /** Conversation + profile + metrics for an explicit customer. */
  async byCustomer(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, phone: true },
    });
    if (!user) throw new NotFoundException('Customer not found');
    return this.bundle(user, null);
  }

  private async bundle(user: CustomerSummary | null, anchorRecipient: string | null) {
    const [conversation, profile] = await Promise.all([
      this.conversation(user, anchorRecipient),
      user ? this.profile(user.id) : Promise.resolve(null),
    ]);
    return {
      customer: user,
      anchorRecipient,
      profile,
      metrics: this.metrics(conversation),
      conversation,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * All notifications addressed to this customer, oldest → newest (latest 200).
   * Matches by recipient (email + phone variants) and, for rows sent to a
   * different delivery phone, by the customerEmail the producers snapshot into
   * the payload. Single indexed query — never per-notification lookups.
   */
  private async conversation(user: CustomerSummary | null, anchorRecipient: string | null) {
    const recipients = new Set<string>();
    if (anchorRecipient) recipients.add(anchorRecipient);
    if (user?.email) recipients.add(user.email);
    for (const v of phoneVariants(user?.phone)) recipients.add(v);

    const or: Prisma.NotificationOutboxWhereInput[] = [];
    if (recipients.size) or.push({ recipient: { in: [...recipients] } });
    if (user?.email) or.push({ payload: { string_contains: user.email } });
    if (or.length === 0) return [];

    const rows = await this.prisma.notificationOutbox.findMany({
      where: { OR: or },
      orderBy: { createdAt: 'desc' },
      take: CONVERSATION_LIMIT,
    });
    return rows.reverse().map((r) => this.toConversationItem(r));
  }

  private toConversationItem(r: NotificationOutbox) {
    const p = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Record<string, unknown>;
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      sentAt: iso(r.sentAt),
      nextAttemptAt: iso(r.nextAttemptAt),
      channel: r.channel,
      status: r.status,
      template: r.template,
      recipient: r.recipient,
      attempts: r.attempts,
      lastError: r.lastError,
      providerMessageId: r.providerMessageId,
      deliverySec: r.sentAt ? Math.round((r.sentAt.getTime() - r.createdAt.getTime()) / 1000) : null,
      subject: this.subjectOf(r.template, r.payload),
      // History badge sources: producers stamp source:'manual'; resend stamps resendAt.
      isManual: p.source === 'manual',
      resendAt: typeof p.resendAt === 'string' ? p.resendAt : null,
      stage: typeof p.stage === 'string' ? p.stage : null,
      statusLabel: typeof p.statusLabel === 'string' ? p.statusLabel : null,
      related: extractRelated(r.payload),
    };
  }

  private subjectOf(template: string, payload: unknown): string | null {
    try {
      return this.renderer.render(template, (payload ?? {}) as Record<string, unknown>).subject;
    } catch {
      return null;
    }
  }

  /** Order aggregates for the profile panel — ONE groupBy over the customer's orders. */
  private async profile(userId: string) {
    const groups = await this.prisma.order.groupBy({
      by: ['status'],
      where: { userId },
      _count: { _all: true },
      _sum: { totalPrice: true },
      _max: { createdAt: true },
    });
    let total = 0;
    let completed = 0;
    let cancelled = 0;
    let lifetimeValue = 0;
    let lastOrderAt: Date | null = null;
    for (const g of groups) {
      total += g._count._all;
      if (COMPLETED_STATUSES.includes(g.status)) {
        completed += g._count._all;
        lifetimeValue += g._sum.totalPrice ?? 0;
      }
      if (g.status === OrderStatus.CANCELLED) cancelled += g._count._all;
      if (g._max.createdAt && (!lastOrderAt || g._max.createdAt > lastOrderAt)) lastOrderAt = g._max.createdAt;
    }
    return { totalOrders: total, completedOrders: completed, cancelledOrders: cancelled, lastOrderAt: iso(lastOrderAt), lifetimeValue };
  }

  /** Per-customer notification metrics, computed over the conversation window. */
  private metrics(conversation: Array<{ status: string; deliverySec: number | null; createdAt: string }>) {
    const sent = conversation.filter((c) => c.status === 'SENT').length;
    const failed = conversation.filter((c) => c.status === 'FAILED').length;
    const durations = conversation.map((c) => c.deliverySec).filter((d): d is number => d !== null);
    const denominator = sent + failed;
    return {
      total: conversation.length,
      sent,
      failed,
      pending: conversation.length - sent - failed,
      successRatePct: denominator > 0 ? Math.round((sent / denominator) * 1000) / 10 : null,
      avgDeliverySec: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      lastNotificationAt: conversation.length ? conversation[conversation.length - 1].createdAt : null,
    };
  }

  // ---------------- Customer search ----------------

  /** Search customers by name / phone / email / order number / notification id. */
  async search(q: string) {
    const term = q?.trim();
    if (!term || term.length < 2) return { customers: [] };

    const select = { id: true, name: true, email: true, phone: true } as const;
    const [users, orders, notification] = await Promise.all([
      this.prisma.user.findMany({
        where: { deletedAt: null, OR: [{ name: { contains: term } }, { email: { contains: term } }, { phone: { contains: term } }] },
        take: 10,
        select,
      }),
      this.prisma.order.findMany({
        where: { orderNumber: { contains: term } },
        take: 5,
        select: { orderNumber: true, user: { select } },
      }),
      looksLikeUuid(term) ? this.prisma.notificationOutbox.findUnique({ where: { id: term } }) : Promise.resolve(null),
    ]);

    const out = new Map<string, CustomerSummary & { via: string }>();
    for (const u of users) out.set(u.id, { ...u, via: 'profile' });
    for (const o of orders) {
      if (o.user && !out.has(o.user.id)) out.set(o.user.id, { ...o.user, via: `order ${o.orderNumber}` });
    }
    if (notification) {
      const u = await this.resolveUser(notification);
      if (u && !out.has(u.id)) out.set(u.id, { ...u, via: 'notification' });
    }
    return { customers: [...out.values()].slice(0, 10) };
  }

  /** Map an outbox row back to the customer: payload email → recipient → phone → order owner. */
  private async resolveUser(row: NotificationOutbox): Promise<CustomerSummary | null> {
    const select = { id: true, name: true, email: true, phone: true } as const;
    const p = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>;

    const email =
      (typeof p.customerEmail === 'string' && p.customerEmail) || (row.recipient.includes('@') ? row.recipient : null);
    if (email) {
      const byEmail = await this.prisma.user.findUnique({ where: { email }, select });
      if (byEmail) return byEmail;
    }

    const phones = [
      ...phoneVariants(typeof p.customerPhone === 'string' ? p.customerPhone : null),
      ...(row.recipient.includes('@') ? [] : phoneVariants(row.recipient)),
    ];
    if (phones.length) {
      const byPhone = await this.prisma.user.findFirst({ where: { phone: { in: phones }, deletedAt: null }, select });
      if (byPhone) return byPhone;
    }

    if (typeof p.orderId === 'string' && p.orderId) {
      const order = await this.prisma.order.findUnique({ where: { id: p.orderId }, select: { user: { select } } });
      if (order?.user) return order.user;
    }
    return null;
  }

  // ---------------- Template preview (read-only render; templates stay in code) ----------------

  preview(input: { channel: NotificationChannel; template: ManualTemplate; message: string; customerName?: string; orderNumber?: string; subject?: string }) {
    this.assertManualTemplate(input.template);
    const payload = this.manualPayload(input);
    const rendered = this.renderer.render(input.template, payload);
    return {
      template: input.template,
      variables: MANUAL_TEMPLATE_VARIABLES[input.template],
      rendered,
      // Which channels can actually deliver this template right now (WhatsApp
      // needs QONTAK_MANUAL_TEMPLATE_ID; Email templates are always registered).
      channels: {
        EMAIL: this.channelReady(NotificationChannel.EMAIL, input.template),
        WHATSAPP: this.channelReady(NotificationChannel.WHATSAPP, input.template),
      },
    };
  }

  private channelReady(channel: NotificationChannel, template: ManualTemplate): boolean {
    try {
      this.registry.resolve(channel, template);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------- Manual send (queues through the EXISTING outbox pipeline) ----------------

  async send(admin: { id: string; name: string }, input: ManualSendInput) {
    this.assertManualTemplate(input.template);
    if (input.channel !== NotificationChannel.EMAIL && input.channel !== NotificationChannel.WHATSAPP) {
      throw new BadRequestException('Manual send supports EMAIL and WHATSAPP only');
    }
    // Fail fast (instead of a permanently-FAILED row) when the provider template
    // is not configured for this channel.
    try {
      this.registry.resolve(input.channel, input.template);
    } catch (e) {
      if (e instanceof ConfigurationError) {
        throw new BadRequestException(`${input.channel} manual sends are not configured (${e.message})`);
      }
      throw e;
    }

    let recipient = input.recipient.trim();
    if (input.channel === NotificationChannel.WHATSAPP) {
      try {
        recipient = normalizePhoneNumber(recipient);
      } catch (e) {
        if (e instanceof InvalidPhoneError) throw new BadRequestException(`Invalid WhatsApp number: ${recipient}`);
        throw e;
      }
    } else if (!recipient.includes('@')) {
      throw new BadRequestException('Recipient must be an email address for EMAIL sends');
    }

    // Optional customer link — also enriches the payload so conversation matching
    // and the drawer's Related links work for manual rows.
    const customer = input.customerId
      ? await this.prisma.user.findUnique({ where: { id: input.customerId }, select: { id: true, name: true, email: true, phone: true } })
      : null;
    if (input.customerId && !customer) throw new BadRequestException('Customer not found');

    const row = await this.prisma.notificationOutbox.create({
      data: {
        channel: input.channel,
        recipient,
        template: input.template,
        payload: {
          ...this.manualPayload(input, customer?.name),
          ...(input.orderId ? { orderId: input.orderId } : {}),
          ...(customer ? { customerId: customer.id, customerEmail: customer.email, customerPhone: customer.phone } : {}),
          source: 'manual',
          sentById: admin.id,
          sentByName: admin.name,
        },
        sourceMessageId: randomUUID(),
        // status PENDING + nextAttemptAt now (defaults) → the sender worker
        // claims and delivers it exactly like automatic notifications.
      },
    });
    this.logger.log({ metric: 'manual_notification_queued', id: row.id, channel: row.channel, template: row.template, admin: admin.id });
    return { id: row.id, status: row.status, createdAt: row.createdAt.toISOString() };
  }

  private manualPayload(
    input: { template: ManualTemplate; message: string; customerName?: string; orderNumber?: string; subject?: string },
    fallbackName?: string,
  ): Record<string, unknown> {
    return {
      customerName: input.customerName?.trim() || fallbackName || 'Pelanggan',
      orderNumber: input.orderNumber?.trim() ?? '',
      message: input.message.trim(),
      ...(input.subject?.trim() ? { subject: input.subject.trim() } : {}),
    };
  }

  private assertManualTemplate(template: string): asserts template is ManualTemplate {
    if (!(MANUAL_TEMPLATES as readonly string[]).includes(template)) {
      throw new BadRequestException(`Unknown manual template: ${template}`);
    }
  }
}

/** Indonesian MSISDN variants for matching stored recipients: raw, 62…, 0…, 8… forms. */
export function phoneVariants(phone: string | null | undefined): string[] {
  if (!phone) return [];
  const raw = phone.trim();
  if (!raw) return [];
  const digits = raw.replace(/[^\d]/g, '');
  const variants = new Set<string>([raw]);
  if (digits) {
    variants.add(digits);
    if (digits.startsWith('62')) {
      variants.add(`0${digits.slice(2)}`);
      variants.add(`+${digits}`);
    } else if (digits.startsWith('0')) {
      variants.add(`62${digits.slice(1)}`);
      variants.add(`+62${digits.slice(1)}`);
    } else if (digits.startsWith('8')) {
      variants.add(`62${digits}`);
      variants.add(`0${digits}`);
    }
  }
  return [...variants];
}

function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
