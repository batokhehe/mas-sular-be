import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { NotificationChannel, Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import { PrismaService } from '../../database/prisma.service';
import { NotificationMetrics } from '../notifications/notification.metrics';
import { RabbitConnectionManager } from '../outbox/rabbit-connection.manager';
import { CONSUMERS_CONFIG, ConsumersConfig } from './consumers.config';
import { countDeaths, isInfraError } from './order-created-notification.consumer';

// Topology (mirrors the order consumer):
//   payments --(payment.paid|payment.failed)--> payment.notifications  (main)
//   main --nack(requeue=false)--> default exchange --> payment.notifications.retry (TTL) --> back to main
//   poison / unrecoverable --> payment.notifications.dlq (terminal, confirmed handoff)
const EXCHANGE = 'payments';
const ROUTING_KEYS = ['payment.paid', 'payment.failed', 'payment.expired', 'payment.receipt_uploaded', 'payment.reminder'] as const;
const QUEUE = 'payment.notifications';
const RETRY_QUEUE = 'payment.notifications.retry';
const DLQ = 'payment.notifications.dlq';
const CONSUMER = 'payment.notifications';

// payment event name -> notification template
const TEMPLATE_BY_EVENT: Record<string, string> = {
  'payment.paid': 'payment.approved',
  'payment.failed': 'payment.rejected',
  'payment.expired': 'payment.expired',
  'payment.receipt_uploaded': 'payment.receipt_uploaded',
  'payment.reminder': 'payment.reminder',
};

// Events whose notification targets the admin team rather than the customer.
const ADMIN_RECIPIENT_EVENTS = new Set<string>(['payment.receipt_uploaded']);

type ProcessOutcome = 'enqueued' | 'duplicate' | 'skipped';

/**
 * Turns payment.paid / payment.failed events into customer notifications. Same
 * exactly-once-effect design as the order consumer: a ProcessedEvent row written
 * in the SAME transaction as the NotificationOutbox insert dedups redeliveries.
 */
@Injectable()
export class PaymentNotificationConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('PaymentNotificationConsumer');
  private channel: amqp.ConfirmChannel | null = null;
  private consumerTag: string | null = null;
  private stopped = false;
  private paused = false;
  private reinitTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitConnectionManager,
    private readonly metrics: NotificationMetrics,
    @Inject(CONSUMERS_CONFIG) private readonly config: ConsumersConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.log('Consumers disabled (CONSUMERS_ENABLED=false)');
      return;
    }
    if (!this.config.rabbitmqUrl) {
      this.logger.warn('Consumers enabled but RABBITMQ_URL is not set; consumer idle');
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reinitTimer) clearTimeout(this.reinitTimer);
    try {
      if (this.channel && this.consumerTag) await this.channel.cancel(this.consumerTag);
    } catch {
      // best-effort
    }
    try {
      if (this.channel) await this.channel.close();
    } catch {
      // best-effort
    }
    this.channel = null;
  }

  private async start(): Promise<void> {
    try {
      const channel = await this.rabbit.createConsumerChannel(this.config.prefetch);
      await this.declareTopology(channel);
      channel.on('close', () => this.handleChannelClose());
      channel.on('error', (err: Error) => this.logger.error(`consumer channel error: ${err.message}`));
      this.channel = channel;
      await this.consume(channel);
      this.logger.log(`Consuming ${QUEUE}`);
    } catch (err) {
      this.logger.error(`Failed to start consumer: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReinit();
    }
  }

  private async consume(channel: amqp.ConfirmChannel): Promise<void> {
    const { consumerTag } = await channel.consume(
      QUEUE,
      (msg) => {
        if (msg) void this.handleDelivery(channel, msg);
      },
      { noAck: false },
    );
    this.consumerTag = consumerTag;
  }

  private async declareTopology(channel: amqp.ConfirmChannel): Promise<void> {
    await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    await channel.assertQueue(DLQ, { durable: true });
    await channel.assertQueue(RETRY_QUEUE, {
      durable: true,
      arguments: {
        'x-message-ttl': this.config.retryDelayMs,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': QUEUE,
      },
    });
    await channel.assertQueue(QUEUE, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': RETRY_QUEUE },
    });
    for (const key of ROUTING_KEYS) {
      await channel.bindQueue(QUEUE, EXCHANGE, key);
    }
  }

  async handleDelivery(channel: amqp.ConfirmChannel, msg: amqp.ConsumeMessage): Promise<void> {
    try {
      const messageId = msg.properties.messageId;
      if (!messageId) {
        await this.deadLetter(channel, msg, 'missing messageId');
        return;
      }

      let event: { name?: string; payload?: Record<string, unknown> };
      try {
        event = JSON.parse(msg.content.toString());
      } catch {
        await this.deadLetter(channel, msg, 'unparseable body');
        return;
      }

      try {
        const outcome = await this.process(messageId, event);
        channel.ack(msg);
        this.recordOutcome(outcome);
      } catch (err) {
        if (isUniqueViolation(err)) {
          channel.ack(msg);
          this.metrics.duplicate();
          return;
        }
        if (isInfraError(err)) {
          await this.pauseForInfra(channel, msg);
          return;
        }
        const deaths = countDeaths(msg);
        if (deaths >= this.config.maxAttempts) {
          await this.deadLetter(channel, msg, err);
        } else {
          channel.nack(msg, false, false); // → retry queue (TTL) → back to main
          this.metrics.consumerRetried();
        }
      }
    } catch (dlErr) {
      this.logger.error(`delivery handling failed (left unacked): ${dlErr instanceof Error ? dlErr.message : String(dlErr)}`);
    }
  }

  /** Dedup + enqueue. ProcessedEvent insert shares the tx → exactly-once enqueue. */
  async process(messageId: string, event: { name?: string; payload?: Record<string, unknown> }): Promise<ProcessOutcome> {
    const seen = await this.prisma.processedEvent.findUnique({
      where: { consumer_messageId: { consumer: CONSUMER, messageId } },
    });
    if (seen) return 'duplicate';

    const eventName = event.name ?? '';
    const template = TEMPLATE_BY_EVENT[eventName];
    if (!template) {
      this.logger.warn(`payment event without a mapped template (event=${eventName}, messageId=${messageId}); skipping`);
      return 'skipped';
    }

    const orderId = event.payload?.orderId as string | undefined;
    if (!orderId) {
      this.logger.warn(`${eventName} without orderId (messageId=${messageId}); skipping`);
      return 'skipped';
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: { select: { email: true, name: true } } },
    });
    if (!order) {
      this.logger.warn(`order missing for order ${orderId}; skipping`);
      return 'skipped';
    }

    // Admin-facing events go to the configured admin inbox; customer events go to
    // the order's owner. Either way, a missing recipient is a skip (not a failure).
    const isAdminEvent = ADMIN_RECIPIENT_EVENTS.has(eventName);
    const recipient = isAdminEvent ? this.config.adminNotificationEmail : order.user?.email;
    if (!recipient) {
      this.logger.warn(
        isAdminEvent
          ? `admin notification email not configured; skipping ${eventName}`
          : `recipient missing for order ${orderId}; skipping`,
      );
      return 'skipped';
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.notificationOutbox.create({
          data: {
            channel: NotificationChannel.EMAIL,
            recipient,
            template,
            payload: {
              orderId,
              orderNumber: order.orderNumber,
              customerName: order.user!.name,
              amount: (event.payload?.amount as number | undefined) ?? null,
              // Present for payment.reminder; null/ignored for other events.
              paymentMethod: (event.payload?.paymentMethod as string | undefined) ?? null,
              uploadUrl: (event.payload?.uploadUrl as string | undefined) ?? null,
              stage: (event.payload?.stage as string | undefined) ?? null,
            },
            sourceMessageId: messageId,
          },
        });
        await tx.processedEvent.create({
          data: { consumer: CONSUMER, messageId, eventName },
        });
      });
      return 'enqueued';
    } catch (err) {
      if (isUniqueViolation(err)) return 'duplicate';
      throw err; // transient/infra → caller classifies
    }
  }

  private recordOutcome(outcome: ProcessOutcome): void {
    if (outcome === 'enqueued') this.metrics.enqueued();
    else if (outcome === 'duplicate') this.metrics.duplicate();
    else this.metrics.skipped('unmapped_event_or_recipient_missing');
  }

  /** F2: publish to the DLQ on the confirm channel and await the broker ack BEFORE acking the original. */
  private async deadLetter(channel: amqp.ConfirmChannel, msg: amqp.ConsumeMessage, reason: unknown): Promise<void> {
    const message = reason instanceof Error ? reason.message : String(reason);
    await new Promise<void>((resolve, reject) => {
      channel.sendToQueue(
        DLQ,
        msg.content,
        { ...msg.properties, headers: { ...(msg.properties.headers ?? {}), 'x-dead-letter-reason': message } },
        (err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve()),
      );
    });
    channel.ack(msg);
    this.metrics.deadLettered(message);
    this.logger.error(`Dead-lettered payment notification delivery: ${message}`);
  }

  /** F3: requeue without dead-lettering (no x-death increment), stop consuming, resume after pauseMs. */
  private async pauseForInfra(channel: amqp.ConfirmChannel, msg: amqp.ConsumeMessage): Promise<void> {
    channel.nack(msg, false, true);
    if (this.paused) return;
    this.paused = true;
    this.metrics.consumerPaused();
    this.logger.warn('Dependency unavailable; pausing consumer');
    try {
      if (this.consumerTag) await channel.cancel(this.consumerTag);
    } catch {
      // best-effort
    }
    this.consumerTag = null;
    setTimeout(() => void this.resumeConsuming(channel), this.config.retryDelayMs).unref();
  }

  private async resumeConsuming(channel: amqp.ConfirmChannel): Promise<void> {
    if (this.stopped || !this.paused) return;
    try {
      await this.consume(channel);
      this.paused = false;
      this.metrics.consumerResumed();
      this.logger.log('Consumer resumed');
    } catch {
      setTimeout(() => void this.resumeConsuming(channel), this.config.retryDelayMs).unref();
    }
  }

  private handleChannelClose(): void {
    this.channel = null;
    this.consumerTag = null;
    if (!this.stopped) {
      this.logger.warn('Consumer channel closed; scheduling re-init');
      this.scheduleReinit();
    }
  }

  private scheduleReinit(): void {
    if (this.stopped || this.reinitTimer) return; // single-flight
    this.reinitTimer = setTimeout(() => {
      this.reinitTimer = null;
      void this.start();
    }, this.config.retryDelayMs);
    this.reinitTimer.unref();
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
