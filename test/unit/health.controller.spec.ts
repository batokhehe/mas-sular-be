// The mock MUST mirror the real amqplib: a CommonJS module exporting `connect` at
// the root, with NO `default`. The previous version declared `__esModule: true` and
// a fabricated `default.connect`, which matched the (broken) default import in the
// controller and is precisely why the runtime failure was never caught here.
jest.mock('amqplib', () => ({ connect: jest.fn() }));
import * as amqp from 'amqplib';
import { HealthController } from '../../src/health.controller';

const mockConnect = amqp.connect as unknown as jest.Mock;

function build(over: { mysqlOk?: boolean; redisOk?: boolean } = {}) {
  const prisma = {
    $queryRaw: jest.fn().mockImplementation(() => (over.mysqlOk === false ? Promise.reject(new Error('db down')) : Promise.resolve([{ '1': 1 }]))),
  };
  const cache = {
    set: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(over.redisOk === false ? 'nope' : 'ok'),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controller = new HealthController(prisma as any, cache as any);
  return { controller };
}

describe('HealthController.ready — RabbitMQ-aware readiness', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    mockConnect.mockReset();
    delete process.env.RABBITMQ_URL;
    delete process.env.OUTBOX_RELAY_ENABLED;
    delete process.env.CONSUMERS_ENABLED;
  });
  afterAll(() => {
    process.env = ENV;
  });

  it('ready when DB+Redis ok and RabbitMQ is not required (skipped)', async () => {
    const { controller } = build();
    const res = await controller.ready();
    expect(res).toEqual({ status: 'ready', checks: { mysql: 'ok', redis: 'ok', rabbitmq: 'skipped' } });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('NOT ready when RabbitMQ is required (relay enabled) but no broker URL', async () => {
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    const { controller } = build();
    const res = await controller.ready();
    expect(res.checks.rabbitmq).toBe('failed');
    expect(res.status).toBe('not_ready');
  });

  it('NOT ready when the broker URL is set but unreachable', async () => {
    process.env.CONSUMERS_ENABLED = 'true';
    process.env.RABBITMQ_URL = 'amqp://unreachable';
    mockConnect.mockRejectedValue(new Error('ECONNREFUSED'));
    const { controller } = build();
    const res = await controller.ready();
    expect(res.checks.rabbitmq).toBe('failed');
    expect(res.status).toBe('not_ready');
  });

  it('ready when the broker is reachable', async () => {
    process.env.CONSUMERS_ENABLED = 'true';
    process.env.RABBITMQ_URL = 'amqp://rabbit';
    mockConnect.mockResolvedValue({ close: jest.fn().mockResolvedValue(undefined) });
    const { controller } = build();
    const res = await controller.ready();
    expect(res.checks.rabbitmq).toBe('ok');
    expect(res.status).toBe('ready');
  });

  it('NOT ready when MySQL is down', async () => {
    const { controller } = build({ mysqlOk: false });
    const res = await controller.ready();
    expect(res.checks.mysql).toBe('failed');
    expect(res.status).toBe('not_ready');
  });
});
