import * as amqp from 'amqplib';
import { RabbitConnectionManager } from '../../src/infrastructure/outbox/rabbit-connection.manager';
import { OutboxRelayConfig } from '../../src/infrastructure/outbox/outbox.config';

jest.mock('amqplib');

const config: OutboxRelayConfig = {
  enabled: true,
  rabbitmqUrl: 'amqp://localhost',
  pollIntervalMs: 1000,
  batchSize: 50,
  leaseMs: 30_000,
  backoffBaseMs: 5_000,
  backoffCapMs: 3_600_000,
  healthLogIntervalMs: 60_000,
};

function buildBroker(publishImpl?: (cb: (err: unknown) => void) => void) {
  const channel = {
    on: jest.fn(),
    assertExchange: jest.fn().mockResolvedValue({}),
    publish: jest.fn((_ex: string, _rk: string, _content: Buffer, _opts: unknown, cb: (err: unknown) => void) => {
      (publishImpl ?? ((c) => c(null)))(cb);
      return true;
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const connection = {
    on: jest.fn(),
    createConfirmChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
  };
  (amqp.connect as jest.Mock).mockResolvedValue(connection);
  return { connection, channel };
}

describe('RabbitConnectionManager', () => {
  beforeEach(() => jest.clearAllMocks());

  it('asserts the exchange and resolves when the broker confirms', async () => {
    const { channel } = buildBroker();
    const mgr = new RabbitConnectionManager(config);

    await mgr.publishWithConfirm('payments', 'payment.paid', Buffer.from('{}'), { persistent: true });

    expect(channel.assertExchange).toHaveBeenCalledWith('payments', 'topic', { durable: true });
    expect(channel.publish).toHaveBeenCalledWith(
      'payments',
      'payment.paid',
      expect.any(Buffer),
      expect.objectContaining({ persistent: true }),
      expect.any(Function),
    );
  });

  it('reuses one connection and asserts each exchange only once', async () => {
    const { channel } = buildBroker();
    const mgr = new RabbitConnectionManager(config);

    await mgr.publishWithConfirm('payments', 'payment.paid', Buffer.from('{}'), {});
    await mgr.publishWithConfirm('payments', 'payment.refunded', Buffer.from('{}'), {});
    await mgr.publishWithConfirm('orders', 'order.created', Buffer.from('{}'), {});

    expect(amqp.connect).toHaveBeenCalledTimes(1); // shared connection
    expect((channel.assertExchange as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['payments', 'orders']);
  });

  it('rejects when the broker nacks the message', async () => {
    buildBroker((cb) => cb(new Error('nacked')));
    const mgr = new RabbitConnectionManager(config);

    await expect(
      mgr.publishWithConfirm('payments', 'payment.paid', Buffer.from('{}'), {}),
    ).rejects.toThrow('nacked');
  });

  it('closes channel and connection on shutdown', async () => {
    const { connection, channel } = buildBroker();
    const mgr = new RabbitConnectionManager(config);
    await mgr.publishWithConfirm('payments', 'payment.paid', Buffer.from('{}'), {});

    await mgr.onModuleDestroy();

    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('throws when no broker URL is configured', async () => {
    buildBroker();
    const mgr = new RabbitConnectionManager({ ...config, rabbitmqUrl: undefined });

    await expect(
      mgr.publishWithConfirm('payments', 'payment.paid', Buffer.from('{}'), {}),
    ).rejects.toThrow('RABBITMQ_URL is not configured');
  });
});
