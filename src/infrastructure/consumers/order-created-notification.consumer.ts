import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { NotificationChannel, PaymentMethod, Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import { PrismaService } from '../../database/prisma.service';
import { NotificationMetrics } from '../notifications/notification.metrics';
import { RabbitConnectionManager } from '../outbox/rabbit-connection.manager';
import { CONSUMERS_CONFIG, ConsumersConfig } from './consumers.config';

// Topology (declared idempotently at startup):
//   orders --(order.created)--> order.created.notifications  (main)
//   main --nack(requeue=false)--> default exchange --> order.created.notifications.retry (TTL) --> back to main
//   poison / unrecoverable --> order.created.notifications.dlq (terminal, confirmed handoff)
const EXCHANGE = 'orders';
const ROUTING_KEY = 'order.created';
const QUEUE = 'order.created.notifications';
const RETRY_QUEUE = 'order.created.notifications.retry';
const DLQ = 'order.created.notifications.dlq';
const CONSUMER = 'order.notifications';

type ProcessOutcome = 'enqueued' | 'duplicate' | 'skipped';

@Injectable()
export class OrderCreatedNotificationConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OrderCreatedNotificationConsumer');
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
    await channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
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
          // F3: dependency down — requeue (no x-death increment) and pause; don't burn retries into the DLQ.
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
      // A confirmed DLQ handoff failed → leave the message unacked for redelivery (no loss).
      this.logger.error(`delivery handling failed (left unacked): ${dlErr instanceof Error ? dlErr.message : String(dlErr)}`);
    }
  }

  /**
   * Deep link to the admin order-detail page.
   *
   * The route is `/orders/:id` and it is keyed by Order.id — the admin page
   * reads `params.id` straight into `GET /admin/orders/:id`, which does
   * `findUnique({ where: { id } })`. orderNumber is NOT accepted there.
   *
   * Returns '' when ADMIN_URL is unset; the provider then simply omits the
   * button rather than sending a broken link.
   */
  private adminOrderUrl(orderId: string): string {
    const base = this.config.adminUrl?.replace(/\/+$/, '');
    return base ? `${base}/orders/${orderId}` : '';
  }

  /** Dedup + enqueue. ProcessedEvent insert shares the tx → exactly-once enqueue. */
  async process(messageId: string, event: { name?: string; payload?: Record<string, unknown> }): Promise<ProcessOutcome> {
    const seen = await this.prisma.processedEvent.findUnique({
      where: { consumer_messageId: { consumer: CONSUMER, messageId } },
    });
    if (seen) return 'duplicate';

    const orderId = event.payload?.orderId as string | undefined;
    if (!orderId) {
      this.logger.warn(`order.created without orderId (messageId=${messageId}); skipping`);
      return 'skipped';
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: { select: { email: true, name: true, phone: true } },
        address: { select: { phone: true } },
        // Payment state for the internal alert's "Pembayaran" line.
        payment: { select: { status: true } },
      },
    });
    if (!order || !order.user) {
      this.logger.warn(`order/recipient missing for order ${orderId}; skipping`);
      return 'skipped';
    }

    // WhatsApp recipient: prefer the delivery-address phone (always captured at
    // onboarding/checkout); fall back to User.phone (usually null for OAuth users).
    const phone = order.address?.phone ?? order.user.phone ?? null;

    // Channel = WHATSAPP; template chosen by payment method. The raw upload token is
    // the last path segment of the emitted uploadUrl (non-COD only) — never the hash.
    const isCod = order.paymentMethod === PaymentMethod.COD;
    const uploadUrl = event.payload?.uploadUrl as string | undefined;
    const uploadToken = uploadUrl ? (uploadUrl.split('/').pop() ?? null) : null;
    const template = isCod ? 'order.cod' : 'order.transfer';

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.notificationOutbox.create({
          data: {
            channel: NotificationChannel.WHATSAPP,
            recipient: phone ?? '',
            template,
            payload: {
              orderId,
              orderNumber: event.payload?.orderNumber ?? order.orderNumber,
              totalPrice: event.payload?.totalPrice ?? order.totalPrice,
              customerName: order.user!.name,
              customerPhone: phone,
              customerEmail: order.user!.email,
              paymentMethod: order.paymentMethod,
              uploadToken,
            },
            sourceMessageId: messageId,
          },
        });
        // PAXELBOX-37: the INTERNAL "new order arrived" alert, enqueued in the
        // same transaction so an operator alert can never exist without the
        // customer row that caused it (or vice versa).
        //
        // Deliberately a SECOND outbox row rather than an extra recipient on the
        // customer message: different template, different audience, and it must
        // be independently visible, retryable and gate-checked. It is skipped
        // silently when no operator number is configured, exactly as the admin
        // email events already skip on a missing ADMIN_NOTIFICATION_EMAIL.
        const opsPhone = this.config.opsNotificationWhatsapp;
        if (opsPhone) {
          await tx.notificationOutbox.create({
            data: {
              channel: NotificationChannel.WHATSAPP,
              recipient: opsPhone,
              template: 'order.new',
              payload: {
                orderId,
                orderNumber: order.orderNumber,
                customerName: order.user!.name,
                grandTotal: order.totalPrice,
                paymentSummary: `${order.paymentMethod} · ${order.payment?.status ?? 'PENDING'}`,
                shippingSummary: [order.shippingProvider, order.shippingServiceName ?? order.shippingService]
                  .filter(Boolean)
                  .join(' · '),
                adminOrderUrl: this.adminOrderUrl(orderId),
                // Marks the audience explicitly so this row can never be mistaken
                // for a customer message by anything reading the outbox.
                audience: 'internal',
              },
              // Distinct from the customer row's key so the two never collide.
              sourceMessageId: `${messageId}:ops`,
            },
          });
        }
        await tx.processedEvent.create({
          data: { consumer: CONSUMER, messageId, eventName: event.name ?? 'order.created' },
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
    else this.metrics.skipped('order_or_recipient_missing');
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
    this.logger.error(`Dead-lettered order.created delivery: ${message}`);
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

export function countDeaths(msg: amqp.ConsumeMessage): number {
  const xDeath = msg.properties.headers?.['x-death'];
  if (!Array.isArray(xDeath)) return 0;
  return xDeath.reduce((sum, d) => sum + (typeof d?.count === 'number' ? d.count : 0), 0);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** A dependency-unavailable error (DB connectivity), distinct from a poison message. */
export function isInfraError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientRustPanicError) return true;
  return err instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017'].includes(err.code);
}
