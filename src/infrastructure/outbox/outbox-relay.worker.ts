import { Inject, Injectable, Logger, Optional, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { OutboxEvent, Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { PrismaService } from '../../database/prisma.service';
import { LogService } from '../logging/log.service';
import { RelayMetrics } from '../metrics/relay.metrics';
import { OUTBOX_CONFIG, OutboxRelayConfig } from './outbox.config';
import { RabbitConnectionManager } from './rabbit-connection.manager';

/**
 * Drains pending OutboxEvent rows to RabbitMQ with per-message publisher
 * confirms. A row is marked PUBLISHED only after the broker acks, giving
 * at-least-once delivery: a crash at any point causes re-publish, never loss.
 *
 * Claim -> publish -> mark are three separate steps; no DB transaction is held
 * across the network publish. Concurrency safety comes from a lease-stamp claim
 * (lockedBy/lockedUntil) so multiple in-process relays never touch the same row.
 */
@Injectable()
export class OutboxRelayWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayWorker.name);
  private readonly workerId = `${hostname()}:${process.pid}`;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private lastHealthLogAt = 0;

  // Overridable seams for deterministic tests (not injected by Nest).
  private nowMs: () => number = () => Date.now();
  private randomFn: () => number = Math.random;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitConnectionManager,
    private readonly metrics: RelayMetrics,
    @Inject(OUTBOX_CONFIG) private readonly config: OutboxRelayConfig,
    @Optional() private readonly logs?: LogService,
  ) {}

  /**
   * Fenced write-back (C1): only the relay that still owns the row's lease
   * (`lockedBy` unchanged since the claim) may persist an outcome. A stale relay
   * gets count 0 → logs `lease_lost`, never throws, never overwrites the new
   * owner's state (a duplicate publish is already deduped by consumers).
   */
  private async fencedWriteBack(row: OutboxEvent, data: Prisma.OutboxEventUpdateManyMutationInput, intent: string): Promise<boolean> {
    const { count } = await this.prisma.outboxEvent.updateMany({
      where: { id: row.id, lockedBy: row.lockedBy },
      data,
    });
    if (count === 1) return true;
    this.logger.warn(`OutboxEvent ${row.id}: lease lost before ${intent} — leaving the new owner's state untouched`);
    this.logs?.write({
      level: 'WARN',
      module: 'worker.outbox-relay',
      action: 'lease_lost',
      message: `lease lost before ${intent} (row ${row.id})`,
      metadata: { outboxEventId: row.id, intent, lockedBy: row.lockedBy },
    });
    return false;
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('Outbox relay disabled (OUTBOX_RELAY_ENABLED=false)');
      return;
    }
    if (!this.config.rabbitmqUrl) {
      this.logger.warn('Outbox relay enabled but RABBITMQ_URL is not set; relay idle');
      return;
    }
    this.logger.log(
      `Outbox relay starting (worker=${this.workerId}, batch=${this.config.batchSize}, interval=${this.config.pollIntervalMs}ms)`,
    );
    this.scheduleNext(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // a failed in-flight tick is already logged; just drain it
      }
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runTick();
    }, delayMs);
  }

  private async runTick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    let claimed = 0;
    this.inFlight = (async () => {
      try {
        await this.maybeLogHealth();
        claimed = await this.processBatch();
      } catch (err) {
        this.logger.error(`Relay tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    await this.inFlight;
    this.inFlight = null;
    this.running = false;
    // Adaptive: a full batch likely means backlog -> drain immediately.
    const delay = claimed >= this.config.batchSize ? 0 : this.config.pollIntervalMs;
    this.scheduleNext(delay);
  }

  /** Claim a batch, publish each row in createdAt order, return the claim count. */
  async processBatch(): Promise<number> {
    const rows = await this.claimBatch();
    for (const row of rows) {
      await this.publishRow(row);
    }
    return rows.length;
  }

  private async claimBatch(): Promise<OutboxEvent[]> {
    const claimToken = `${this.workerId}#${randomUUID()}`;
    const now = new Date(this.nowMs());
    const leaseExpiry = new Date(this.nowMs() + this.config.leaseMs);
    const limit = Math.trunc(this.config.batchSize);

    // Lease-stamp claim. batchSize is a validated integer from our own config, so
    // inlining it in LIMIT is injection-safe; all runtime values are parameterized.
    await this.prisma.$executeRawUnsafe(
      'UPDATE `OutboxEvent` SET `lockedUntil` = ?, `lockedBy` = ? ' +
        "WHERE `status` = 'PENDING' AND `nextAttemptAt` <= ? " +
        'AND (`lockedUntil` IS NULL OR `lockedUntil` < ?) ' +
        `ORDER BY \`createdAt\` ASC LIMIT ${limit}`,
      leaseExpiry,
      claimToken,
      now,
      now,
    );

    // claimToken carries a fresh uuid each tick, so it uniquely identifies this claim.
    return this.prisma.outboxEvent.findMany({
      where: { lockedBy: claimToken, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
  }

  async publishRow(row: OutboxEvent): Promise<void> {
    const start = this.nowMs();
    try {
      const body = Buffer.from(
        JSON.stringify({
          id: row.id,
          name: row.eventName,
          occurredAt: row.occurredAt,
          payload: row.payload,
        }),
      );
      const options: amqp.Options.Publish = {
        contentType: 'application/json',
        persistent: true,
        messageId: row.id,
        timestamp: Math.floor(row.occurredAt.getTime() / 1000),
        type: row.eventName,
        appId: 'mas-sular-backend',
        headers: this.buildHeaders(row),
      };
      await this.rabbit.publishWithConfirm(row.exchange, row.routingKey, body, options);
      await this.markPublished(row);
      this.metrics.publishedOk((this.nowMs() - start) / 1000);
    } catch (err) {
      await this.scheduleRetry(row, err);
    }
  }

  private buildHeaders(row: OutboxEvent): Record<string, unknown> {
    const headers: Record<string, unknown> = { 'x-event-version': row.eventVersion };
    if (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)) {
      Object.assign(headers, row.metadata as Record<string, unknown>);
    }
    return headers;
  }

  private async markPublished(row: OutboxEvent): Promise<void> {
    await this.fencedWriteBack(
      row,
      { status: 'PUBLISHED', publishedAt: new Date(this.nowMs()), lockedUntil: null, lockedBy: null, lastError: null },
      'markPublished',
    );
  }

  private async scheduleRetry(row: OutboxEvent, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = row.attempts + 1;

    if (attempts >= row.maxAttempts) {
      const owned = await this.fencedWriteBack(
        row,
        { status: 'FAILED', attempts, lastError: message, lockedUntil: null, lockedBy: null },
        'markFailed',
      );
      if (owned) {
        this.metrics.failedTerminal();
        this.logger.error(`OutboxEvent ${row.id} (${row.eventName}) FAILED after ${attempts} attempts: ${message}`);
      }
      return;
    }

    const delay = this.backoffDelayMs(attempts);
    const nextAttemptAt = new Date(this.nowMs() + delay);
    const owned = await this.fencedWriteBack(
      row,
      { attempts, nextAttemptAt, lastError: message, lockedUntil: null, lockedBy: null },
      'scheduleRetry',
    );
    if (owned) {
      this.metrics.retried();
      this.logger.warn(`OutboxEvent ${row.id} publish failed (attempt ${attempts}); retry in ${delay}ms: ${message}`);
    }
  }

  /** Full-jitter exponential backoff in [0, cap). */
  private backoffDelayMs(attempts: number): number {
    const exp = this.config.backoffBaseMs * Math.pow(2, attempts - 1);
    const capped = Math.min(this.config.backoffCapMs, exp);
    return Math.floor(this.randomFn() * capped);
  }

  private async maybeLogHealth(): Promise<void> {
    const now = this.nowMs();
    if (now - this.lastHealthLogAt < this.config.healthLogIntervalMs) return;
    this.lastHealthLogAt = now;

    const [pendingCount, failedCount, oldest] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
      this.prisma.outboxEvent.count({ where: { status: 'FAILED' } }),
      this.prisma.outboxEvent.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    const oldestPendingAgeMs = oldest ? now - oldest.createdAt.getTime() : 0;
    this.metrics.health({ pending: pendingCount, failed: failedCount, oldestPendingAgeMs });
    this.logger.log(
      `relay health: pending_count=${pendingCount} failed_count=${failedCount} oldest_pending_age_ms=${oldestPendingAgeMs}`,
    );
  }
}
