import { Inject, Injectable, Logger, Optional, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { NotificationOutbox, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { PrismaService } from '../../database/prisma.service';
import { LogService } from '../logging/log.service';
import { ConfigurationError } from '../../common/errors/configuration.error';
import { InvalidPhoneError } from '../../common/utils/phone.util';
import { NotificationBlockedError, NotificationDeliveryGate } from './notification-delivery.gate';
import { NotificationMessageBuilder } from './notification-message.builder';
import { NotificationProviderFactory } from './notification-provider.factory';
import { NOTIFICATION_SENDER_CONFIG, NotificationSenderConfig } from './notification.config';
import { NotificationMetrics } from './notification.metrics';
import { PermanentSendError, TransientSendError } from './notification-provider';

/**
 * Drains PENDING NotificationOutbox rows and delivers them via a provider, using
 * the same lease-stamp claim as the outbox relay. Delivery is at-least-once
 * (crash after send / before markSent → reclaim → re-send with NotificationOutbox.id
 * as the provider idempotency key → exactly-once delivery effect). A circuit
 * breaker pauses sends on sustained transient/infra failure (F3).
 */
@Injectable()
export class NotificationSenderWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('NotificationSenderWorker');
  private readonly workerId = `${hostname()}:${process.pid}`;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private lastHealthLogAt = 0;

  private consecutiveTransient = 0;
  private pausedUntil = 0;

  // Overridable seams for deterministic tests.
  private nowMs: () => number = () => Date.now();
  private randomFn: () => number = Math.random;

  constructor(
    private readonly prisma: PrismaService,
    private readonly builder: NotificationMessageBuilder,
    private readonly factory: NotificationProviderFactory,
    private readonly metrics: NotificationMetrics,
    @Inject(NOTIFICATION_SENDER_CONFIG) private readonly config: NotificationSenderConfig,
    // REQUIRED, deliberately not @Optional(): a safety boundary that can be
    // omitted is a safety boundary that fails open. A wiring mistake must break
    // loudly here rather than quietly re-enable unrestricted delivery.
    private readonly gate: NotificationDeliveryGate,
    @Optional() private readonly logs?: LogService,
  ) {}

  /**
   * Fenced write-back (C1): a row may only be persisted by the worker that still
   * OWNS its lease (`lockedBy` unchanged since the claim). A stale worker that
   * lost the lease mid-send gets count 0 → the new owner's state stands; we log
   * `lease_lost` and never throw (the provider side effect already happened —
   * only persistence ownership is being protected).
   */
  private async fencedWriteBack(
    row: NotificationOutbox,
    data: Prisma.NotificationOutboxUpdateManyMutationInput,
    intent: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.notificationOutbox.updateMany({
      where: { id: row.id, lockedBy: row.lockedBy },
      data,
    });
    if (count === 1) return true;
    this.logger.warn(`NotificationOutbox ${row.id}: lease lost before ${intent} — leaving the new owner's state untouched`);
    this.logs?.write({
      level: 'WARN',
      module: 'worker.notification-sender',
      action: 'lease_lost',
      message: `lease lost before ${intent} (row ${row.id})`,
      metadata: { notificationOutboxId: row.id, intent, lockedBy: row.lockedBy },
    });
    return false;
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('Notification sender disabled (NOTIFICATION_SENDER_ENABLED=false)');
      return;
    }
    this.logger.log(`Notification sender starting (worker=${this.workerId}, batch=${this.config.batchSize})`);
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
        // already logged
      }
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.runTick(), delayMs);
    this.timer.unref();
  }

  private async runTick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    let processed = 0;
    this.inFlight = (async () => {
      try {
        await this.maybeLogHealth();
        if (this.isPaused()) return; // breaker open → skip this tick
        processed = await this.processBatch();
      } catch (err) {
        // Tick-level failure (e.g. DB down during claim) — infra transient.
        this.logger.error(`sender tick failed: ${err instanceof Error ? err.message : String(err)}`);
        this.tripBreaker();
      }
    })();
    await this.inFlight;
    this.inFlight = null;
    this.running = false;
    const delay = processed >= this.config.batchSize ? 0 : this.config.pollIntervalMs;
    this.scheduleNext(delay);
  }

  async processBatch(): Promise<number> {
    const rows = await this.claimBatch();
    this.metrics.claimed(rows.length);
    for (const row of rows) {
      await this.sendRow(row);
    }
    return rows.length;
  }

  private async claimBatch(): Promise<NotificationOutbox[]> {
    const claimToken = `${this.workerId}#${randomUUID()}`;
    const now = new Date(this.nowMs());
    const leaseExpiry = new Date(this.nowMs() + this.config.leaseMs);
    const limit = Math.trunc(this.config.batchSize);

    await this.prisma.$executeRawUnsafe(
      'UPDATE `NotificationOutbox` SET `lockedUntil` = ?, `lockedBy` = ? ' +
        "WHERE `status` = 'PENDING' AND `nextAttemptAt` <= ? " +
        'AND (`lockedUntil` IS NULL OR `lockedUntil` < ?) ' +
        `ORDER BY \`nextAttemptAt\` ASC LIMIT ${limit}`,
      leaseExpiry,
      claimToken,
      now,
      now,
    );

    return this.prisma.notificationOutbox.findMany({
      where: { lockedBy: claimToken, status: 'PENDING' },
      orderBy: { nextAttemptAt: 'asc' },
    });
  }

  async sendRow(row: NotificationOutbox): Promise<void> {
    try {
      // Builder owns business composition (active account, phone, template id);
      // factory resolves the provider by channel; provider is transport-only.
      const message = await this.builder.build(row);
      // THE safety boundary. Everything above this line is composition and is
      // allowed to happen for every row; nothing below it may run unless
      // delivery is explicitly enabled AND this recipient is explicitly
      // authorized. Placed before the factory so WhatsApp and Email are
      // covered by one guard and neither provider filters recipients itself.
      this.gate.assertDeliverable(message);
      const provider = this.factory.get(row.channel);
      const result = await provider.send(message);
      await this.markSent(row, result.providerMessageId);
      this.metrics.sent();
      this.resetBreaker();
    } catch (err) {
      // ConfigurationError (no active account / unresolved template) and InvalidPhoneError
      // are non-retryable, same as a provider PermanentSendError.
      //
      // NotificationBlockedError joins them: a row refused by the safety gate
      // must NOT sit PENDING with a backoff, because that would make it deliver
      // itself the moment someone enables delivery. Terminal FAILED means
      // reviving it always costs a deliberate, authenticated resend — which is
      // itself re-checked by the gate.
      if (
        err instanceof PermanentSendError ||
        err instanceof ConfigurationError ||
        err instanceof InvalidPhoneError ||
        err instanceof NotificationBlockedError
      ) {
        await this.markFailed(row, err);
        this.metrics.failedPermanent();
        return;
      }
      this.tripBreaker();
      await this.scheduleRetry(row, err);
    }
  }

  private async markSent(row: NotificationOutbox, providerMessageId: string): Promise<void> {
    await this.fencedWriteBack(
      row,
      {
        status: 'SENT',
        sentAt: new Date(this.nowMs()),
        providerMessageId,
        lockedUntil: null,
        lockedBy: null,
        lastError: null,
      },
      'markSent',
    );
  }

  private async markFailed(row: NotificationOutbox, err: unknown): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    const owned = await this.fencedWriteBack(
      row,
      { status: 'FAILED', attempts: row.attempts + 1, lastError: message, lockedUntil: null, lockedBy: null },
      'markFailed',
    );
    if (owned) this.logger.error(`NotificationOutbox ${row.id} permanently FAILED: ${message}`);
  }

  private async scheduleRetry(row: NotificationOutbox, err: unknown): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    const attempts = row.attempts + 1;

    if (attempts >= this.config.maxAttempts) {
      const owned = await this.fencedWriteBack(
        row,
        { status: 'FAILED', attempts, lastError: message, lockedUntil: null, lockedBy: null },
        'markExhausted',
      );
      if (owned) {
        this.metrics.failedExhausted();
        this.logger.error(`NotificationOutbox ${row.id} FAILED after ${attempts} attempts: ${message}`);
      }
      return;
    }

    // Honor a provider-suggested Retry-After (e.g. 429), else exponential backoff.
    const retryAfterMs = err instanceof TransientSendError ? err.retryAfterMs : undefined;
    const delay = retryAfterMs ?? this.backoffDelayMs(attempts);
    const owned = await this.fencedWriteBack(
      row,
      { attempts, nextAttemptAt: new Date(this.nowMs() + delay), lastError: message, lockedUntil: null, lockedBy: null },
      'scheduleRetry',
    );
    if (owned) {
      this.metrics.retried();
      this.logger.warn(`NotificationOutbox ${row.id} send failed (attempt ${attempts}); retry in ${delay}ms: ${message}`);
    }
  }

  /** Full-jitter exponential backoff in [0, cap). */
  private backoffDelayMs(attempts: number): number {
    const exp = this.config.backoffBaseMs * Math.pow(2, attempts - 1);
    const capped = Math.min(this.config.backoffCapMs, exp);
    return Math.floor(this.randomFn() * capped);
  }

  // ---- circuit breaker (F3) ----
  private isPaused(): boolean {
    return this.nowMs() < this.pausedUntil;
  }

  private tripBreaker(): void {
    this.consecutiveTransient += 1;
    if (this.consecutiveTransient >= this.config.breakerThreshold && !this.isPaused()) {
      this.pausedUntil = this.nowMs() + this.config.pauseMs;
      this.metrics.senderPaused();
      this.logger.warn(`Notification sender paused for ${this.config.pauseMs}ms after ${this.consecutiveTransient} transient failures`);
    }
  }

  private resetBreaker(): void {
    if (this.consecutiveTransient > 0 || this.pausedUntil > 0) {
      this.consecutiveTransient = 0;
      this.pausedUntil = 0;
      this.metrics.senderResumed();
    }
  }

  private async maybeLogHealth(): Promise<void> {
    const now = this.nowMs();
    if (now - this.lastHealthLogAt < this.config.healthLogIntervalMs) return;
    this.lastHealthLogAt = now;

    const [pending, failed, oldest] = await Promise.all([
      this.prisma.notificationOutbox.count({ where: { status: 'PENDING' } }),
      this.prisma.notificationOutbox.count({ where: { status: 'FAILED' } }),
      this.prisma.notificationOutbox.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    const oldestPendingAgeMs = oldest ? now - oldest.createdAt.getTime() : 0;
    this.metrics.health('sender', { pending, failed, oldestPendingAgeMs });
    this.logger.log(`sender health: pending_count=${pending} failed_count=${failed} oldest_pending_age_ms=${oldestPendingAgeMs}`);
  }
}
