import { Injectable, Logger } from '@nestjs/common';
import * as amqp from 'amqplib';
import { PrismaService } from '../../database/prisma.service';
import { RabbitConnectionManager } from '../outbox/rabbit-connection.manager';
import { LifecycleMetrics } from './lifecycle.metrics';

// Consumer DLQ topology (mirrors order-created-notification.consumer.ts).
const DLQ = 'order.created.notifications.dlq';
const REDRIVE_EXCHANGE = 'orders';
const REDRIVE_ROUTING_KEY = 'order.created';

const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_BATCHES = 1_000;

export interface OutboxRedriveFilter {
  id?: string;
  eventName?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  dryRun?: boolean;
  batchSize?: number;
  maxBatches?: number;
}

export interface NotificationRedriveFilter {
  id?: string;
  /** Bulk selection (admin multi-select). Combined into one `id IN (...)` batch. */
  ids?: string[];
  template?: string;
  channel?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  dryRun?: boolean;
  batchSize?: number;
  maxBatches?: number;
}

export interface RedriveResult {
  matched: number; // dry-run count
  redriven: number; // rows reset FAILED -> PENDING
  dryRun: boolean;
}

export interface DlqRedriveResult {
  inspected: number;
  redriven: number;
  dryRun: boolean;
}

/**
 * Admin/CLI-invoked recovery tooling. Resets FAILED outbox/notification rows back
 * to PENDING (the relay/sender re-process them; downstream dedup makes it safe),
 * and shovels consumer DLQ messages back to the source exchange. No automatic
 * redrive. Idempotent: a `status='FAILED'` guard means non-FAILED rows are never
 * mutated, and re-running simply matches fewer rows.
 */
@Injectable()
export class RedriveService {
  private readonly logger = new Logger('RedriveService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitConnectionManager,
    private readonly metrics: LifecycleMetrics,
  ) {}

  // A. OutboxEvent FAILED -> PENDING
  async redriveFailedOutboxEvents(filter: OutboxRedriveFilter = {}): Promise<RedriveResult> {
    const { where, params } = buildOutboxWhere(filter);
    return this.redriveFailedRows('OutboxEvent', '`OutboxEvent`', 'outbox', where, params, filter);
  }

  // B. NotificationOutbox FAILED -> PENDING
  async redriveFailedNotifications(filter: NotificationRedriveFilter = {}): Promise<RedriveResult> {
    const { where, params } = buildNotificationWhere(filter);
    return this.redriveFailedRows('NotificationOutbox', '`NotificationOutbox`', 'notification', where, params, filter);
  }

  private async redriveFailedRows(
    name: string,
    table: string,
    type: 'outbox' | 'notification',
    where: string,
    whereParams: unknown[],
    opts: { dryRun?: boolean; batchSize?: number; maxBatches?: number },
  ): Promise<RedriveResult> {
    if (opts.dryRun) {
      const matched = await this.countMatching(table, where, whereParams);
      this.audit({ op: 'redrive_failed', table: name, dryRun: true, matched });
      return { matched, redriven: 0, dryRun: true };
    }

    const limit = Math.trunc(opts.batchSize ?? DEFAULT_BATCH_SIZE);
    const maxBatches = Math.trunc(opts.maxBatches ?? DEFAULT_MAX_BATCHES);
    const now = new Date();
    let redriven = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const affected = Number(
        await this.prisma.$executeRawUnsafe(
          `UPDATE ${table} SET \`status\` = 'PENDING', \`attempts\` = 0, \`nextAttemptAt\` = ?, ` +
            '`lockedUntil` = NULL, `lockedBy` = NULL, `lastError` = NULL ' +
            `WHERE ${where} LIMIT ${limit}`,
          now,
          ...whereParams,
        ),
      );
      redriven += affected;
      if (affected < limit) break;
    }
    this.metrics.redrive(type, redriven);
    this.audit({ op: 'redrive_failed', table: name, dryRun: false, redriven });
    return { matched: 0, redriven, dryRun: false };
  }

  // C. Consumer DLQ -> bounded shovel back to the source exchange/routing key
  async redriveConsumerDlq(options: { limit: number; dryRun?: boolean }): Promise<DlqRedriveResult> {
    const limit = Math.max(0, Math.trunc(options.limit));
    const dryRun = !!options.dryRun;
    const channel = await this.rabbit.createConsumerChannel(0);
    let inspected = 0;
    let redriven = 0;
    try {
      for (let i = 0; i < limit; i += 1) {
        const msg = await channel.get(DLQ, { noAck: false });
        if (!msg) break; // queue drained
        inspected += 1;
        if (dryRun) {
          channel.nack(msg, false, true); // leave the message in place
          this.logger.log({ metric: 'redrive_dlq_inspect', messageId: msg.properties.messageId });
        } else {
          await this.publishConfirmed(channel, REDRIVE_EXCHANGE, REDRIVE_ROUTING_KEY, msg.content, msg.properties);
          channel.ack(msg);
          redriven += 1;
        }
      }
    } finally {
      try {
        await channel.close();
      } catch {
        // best-effort
      }
    }
    if (!dryRun) this.metrics.dlqRedrive(redriven);
    this.audit({ op: 'redrive_dlq', dryRun, inspected, redriven, limit });
    return { inspected, redriven, dryRun };
  }

  private publishConfirmed(
    channel: amqp.ConfirmChannel,
    exchange: string,
    routingKey: string,
    content: Buffer,
    properties: amqp.MessageProperties,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      channel.publish(exchange, routingKey, content, properties, (err) =>
        err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(),
      );
    });
  }

  private async countMatching(table: string, where: string, params: unknown[]): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ c: number | bigint }>>(
      `SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`,
      ...params,
    );
    return Number(rows[0]?.c ?? 0);
  }

  private audit(fields: Record<string, unknown>): void {
    this.logger.log({ metric: 'redrive', ...fields });
  }
}

function buildOutboxWhere(f: OutboxRedriveFilter): { where: string; params: unknown[] } {
  const parts = ["`status` = 'FAILED'"];
  const params: unknown[] = [];
  if (f.id) {
    parts.push('`id` = ?');
    params.push(f.id);
  }
  if (f.eventName) {
    parts.push('`eventName` = ?');
    params.push(f.eventName);
  }
  if (f.createdAfter) {
    parts.push('`createdAt` >= ?');
    params.push(f.createdAfter);
  }
  if (f.createdBefore) {
    parts.push('`createdAt` < ?');
    params.push(f.createdBefore);
  }
  return { where: parts.join(' AND '), params };
}

function buildNotificationWhere(f: NotificationRedriveFilter): { where: string; params: unknown[] } {
  const parts = ["`status` = 'FAILED'"];
  const params: unknown[] = [];
  if (f.id) {
    parts.push('`id` = ?');
    params.push(f.id);
  }
  if (f.ids && f.ids.length > 0) {
    parts.push(`\`id\` IN (${f.ids.map(() => '?').join(', ')})`);
    params.push(...f.ids);
  }
  if (f.template) {
    parts.push('`template` = ?');
    params.push(f.template);
  }
  if (f.channel) {
    parts.push('`channel` = ?');
    params.push(f.channel);
  }
  if (f.createdAfter) {
    parts.push('`createdAt` >= ?');
    params.push(f.createdAfter);
  }
  if (f.createdBefore) {
    parts.push('`createdAt` < ?');
    params.push(f.createdBefore);
  }
  return { where: parts.join(' AND '), params };
}
