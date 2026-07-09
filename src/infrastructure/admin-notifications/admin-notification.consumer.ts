import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import { PrismaService } from '../../database/prisma.service';
import { RabbitConnectionManager } from '../outbox/rabbit-connection.manager';
import { CONSUMERS_CONFIG, ConsumersConfig } from '../consumers/consumers.config';
import { buildAdminNotification } from './admin-notification.builder';
import { AdminNotificationDispatcher } from './admin-notification.dispatcher';
import { AdminNotificationMetrics } from './admin-notification.metrics';

// Topology (mirrors order-created-notification.consumer):
//   orders/payments --(#)--> admin.notifications (main)
//   main --nack--> retry queue (TTL) --> back to main;  poison --> DLQ.
const SOURCE_EXCHANGES = ['orders', 'payments'];
const QUEUE = 'admin.notifications';
const RETRY_QUEUE = 'admin.notifications.retry';
const DLQ = 'admin.notifications.dlq';
const CONSUMER = 'admin.notifications';

/**
 * Event-driven notification worker. Consumes EVERY domain event on the orders/
 * payments exchanges; the pure builder decides which become notifications. The
 * worker never knows who produced an event. Idempotent via ProcessedEvent (same
 * pattern as the existing consumer) — a redelivered event is acked, not re-sent.
 */
@Injectable()
export class AdminNotificationConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('AdminNotificationConsumer');
  private channel: amqp.ConfirmChannel | null = null;
  private consumerTag: string | null = null;
  private stopped = false;
  private reinitTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitConnectionManager,
    private readonly dispatcher: AdminNotificationDispatcher,
    private readonly metrics: AdminNotificationMetrics,
    @Inject(CONSUMERS_CONFIG) private readonly config: ConsumersConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled || !this.config.rabbitmqUrl) {
      this.logger.log('Admin notification consumer idle (consumers disabled or no RABBITMQ_URL)');
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reinitTimer) clearTimeout(this.reinitTimer);
    try {
      if (this.channel && this.consumerTag) await this.channel.cancel(this.consumerTag);
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
      channel.on('close', () => this.scheduleReinit());
      channel.on('error', (err: Error) => this.logger.error(`consumer channel error: ${err.message}`));
      this.channel = channel;
      const { consumerTag } = await channel.consume(QUEUE, (msg) => {
        if (msg) void this.handleDelivery(channel, msg);
      }, { noAck: false });
      this.consumerTag = consumerTag;
      this.logger.log(`Consuming ${QUEUE}`);
    } catch (err) {
      this.logger.error(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReinit();
    }
  }

  private async declareTopology(channel: amqp.ConfirmChannel): Promise<void> {
    await channel.assertQueue(DLQ, { durable: true });
    await channel.assertQueue(RETRY_QUEUE, {
      durable: true,
      arguments: { 'x-message-ttl': this.config.retryDelayMs, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': QUEUE },
    });
    await channel.assertQueue(QUEUE, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': RETRY_QUEUE },
    });
    for (const exchange of SOURCE_EXCHANGES) {
      await channel.assertExchange(exchange, 'topic', { durable: true });
      await channel.bindQueue(QUEUE, exchange, '#'); // the builder filters relevance
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
        await this.process(messageId, event);
        channel.ack(msg);
        this.metrics.consumed();
      } catch (err) {
        if (isUniqueViolation(err)) {
          channel.ack(msg); // concurrent duplicate — already processed
          this.metrics.duplicate();
          return;
        }
        const deaths = countDeaths(msg);
        if (deaths >= this.config.maxAttempts) await this.deadLetter(channel, msg, err);
        else channel.nack(msg, false, false); // → retry queue (TTL backoff)
      }
    } catch (dlErr) {
      this.logger.error(`delivery handling failed (left unacked): ${dlErr instanceof Error ? dlErr.message : String(dlErr)}`);
    }
  }

  /** Idempotent processing: ProcessedEvent insert shares the outcome exactly-once. */
  async process(messageId: string, event: { name?: string; payload?: Record<string, unknown> }): Promise<'created' | 'duplicate' | 'skipped'> {
    const seen = await this.prisma.processedEvent.findUnique({
      where: { consumer_messageId: { consumer: CONSUMER, messageId } },
    });
    if (seen) {
      this.metrics.duplicate();
      return 'duplicate';
    }

    const draft = buildAdminNotification(event.name ?? '', event.payload);
    // Mark processed FIRST (unique-guarded) so a crash mid-dispatch never double-notifies.
    await this.prisma.processedEvent.create({
      data: { consumer: CONSUMER, messageId, eventName: event.name ?? 'unknown' },
    });
    if (!draft) return 'skipped'; // event not notification-worthy — still deduped

    await this.dispatcher.dispatch(draft);
    return 'created';
  }

  private async deadLetter(channel: amqp.ConfirmChannel, msg: amqp.ConsumeMessage, reason: unknown): Promise<void> {
    const message = reason instanceof Error ? reason.message : String(reason);
    await new Promise<void>((resolve, reject) => {
      channel.sendToQueue(DLQ, msg.content, { ...msg.properties, headers: { ...(msg.properties.headers ?? {}), 'x-dead-letter-reason': message } }, (err) =>
        err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(),
      );
    });
    channel.ack(msg);
    this.metrics.deadLettered();
    this.logger.error(`Dead-lettered admin notification delivery: ${message}`);
  }

  private scheduleReinit(): void {
    if (this.stopped || this.reinitTimer) return;
    this.reinitTimer = setTimeout(() => {
      this.reinitTimer = null;
      void this.start();
    }, this.config.retryDelayMs);
    this.reinitTimer.unref();
  }
}

function countDeaths(msg: amqp.ConsumeMessage): number {
  const xDeath = msg.properties.headers?.['x-death'];
  if (!Array.isArray(xDeath)) return 0;
  return xDeath.reduce((sum, d) => sum + (typeof d?.count === 'number' ? d.count : 0), 0);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
