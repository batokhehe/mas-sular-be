import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as amqp from 'amqplib';
import { OUTBOX_CONFIG, OutboxRelayConfig } from './outbox.config';

/**
 * Owns a single shared AMQP connection and one confirm channel for the relay.
 * Reconnection is lazy: on connection/channel close the handles are dropped and
 * recreated on the next publish attempt, so a broker blip never crashes the
 * process — failed publishes simply leave their OutboxEvent rows PENDING.
 */
@Injectable()
export class RabbitConnectionManager implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitConnectionManager.name);
  private connection: amqp.Connection | null = null;
  private channel: amqp.ConfirmChannel | null = null;
  private connecting: Promise<amqp.ConfirmChannel> | null = null;
  private readonly assertedExchanges = new Set<string>();
  private closing = false;

  constructor(@Inject(OUTBOX_CONFIG) private readonly config: OutboxRelayConfig) {}

  /** Publish a single message and resolve only after the broker confirms (acks). */
  async publishWithConfirm(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: amqp.Options.Publish,
  ): Promise<void> {
    const channel = await this.getChannel();
    await this.ensureExchange(channel, exchange);
    await new Promise<void>((resolve, reject) => {
      channel.publish(exchange, routingKey, content, options, (err) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          resolve();
        }
      });
    });
  }

  private async getChannel(): Promise<amqp.ConfirmChannel> {
    if (this.channel) return this.channel;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * A dedicated confirm channel for consumers, on the shared connection. It is a
   * ConfirmChannel so consumers can publish to a DLQ and await the broker ack
   * before acking the original message (F2 — no unconfirmed DLQ handoff).
   */
  async createConsumerChannel(prefetch: number): Promise<amqp.ConfirmChannel> {
    const connection = await this.ensureConnection();
    const channel = await connection.createConfirmChannel();
    if (prefetch > 0) await channel.prefetch(prefetch);
    channel.on('error', (err: Error) => this.logger.error(`AMQP consumer channel error: ${err.message}`));
    return channel;
  }

  private async ensureConnection(): Promise<amqp.Connection> {
    if (this.connection) return this.connection;
    if (!this.config.rabbitmqUrl) {
      throw new Error('RABBITMQ_URL is not configured');
    }
    const connection = await amqp.connect(this.config.rabbitmqUrl);
    connection.on('error', (err: Error) => this.logger.error(`AMQP connection error: ${err.message}`));
    connection.on('close', () => this.handleClose());
    this.connection = connection;
    return connection;
  }

  private async connect(): Promise<amqp.ConfirmChannel> {
    const connection = await this.ensureConnection();
    const channel = await connection.createConfirmChannel();
    channel.on('error', (err: Error) => this.logger.error(`AMQP channel error: ${err.message}`));
    channel.on('close', () => {
      this.channel = null;
      this.assertedExchanges.clear();
    });

    this.channel = channel;
    this.assertedExchanges.clear();
    this.logger.log('AMQP confirm channel established');
    return channel;
  }

  private handleClose(): void {
    this.channel = null;
    this.connection = null;
    this.assertedExchanges.clear();
    if (!this.closing) {
      this.logger.warn('AMQP connection closed; will reconnect on next publish');
    }
  }

  private async ensureExchange(channel: amqp.ConfirmChannel, exchange: string): Promise<void> {
    if (this.assertedExchanges.has(exchange)) return;
    await channel.assertExchange(exchange, 'topic', { durable: true });
    this.assertedExchanges.add(exchange);
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    try {
      if (this.channel) await this.channel.close();
    } catch (err) {
      this.logger.warn(`Error closing channel: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      if (this.connection) await this.connection.close();
    } catch (err) {
      this.logger.warn(`Error closing connection: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.channel = null;
    this.connection = null;
  }
}
