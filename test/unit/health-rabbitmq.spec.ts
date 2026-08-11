import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression for the RabbitMQ readiness probe.
 *
 * The probe used `import amqp from 'amqplib'`, which under `module: commonjs`
 * WITHOUT `esModuleInterop` emits `amqplib_1.default.connect(...)`. amqplib is
 * CommonJS with no `default` export, so that threw
 * "Cannot read properties of undefined (reading 'connect')" before any socket was
 * opened — making readiness a permanent false negative on every environment.
 *
 * These tests never open a real connection and never touch a database.
 */

const connectMock = jest.fn();
jest.mock('amqplib', () => ({ connect: (...args: unknown[]) => connectMock(...args) }));

// Imported after the mock so the controller binds to it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HealthController } = require('../../src/health.controller') as typeof import('../../src/health.controller');

const RABBIT_URL = 'amqps://user:pass@broker.example.test:5671/vhost';

function controller(opts: { redisOk?: boolean; mysqlOk?: boolean } = {}) {
  const prisma = {
    $queryRaw: jest.fn(async () => {
      if (opts.mysqlOk === false) throw new Error('db down');
      return [{ 1: 1 }];
    }),
  };
  const cache = {
    set: jest.fn(async () => undefined),
    get: jest.fn(async () => (opts.redisOk === false ? 'nope' : 'ok')),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new HealthController(prisma as any, cache as any);
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, RABBITMQ_URL: RABBIT_URL };
});
afterAll(() => { process.env = ORIGINAL_ENV; });

// ================================================= the import itself ========

describe('the amqplib import shape', () => {
  it('amqplib exposes connect at the module root, and has NO default export', () => {
    const actual = jest.requireActual('amqplib') as Record<string, unknown>;
    expect(typeof actual.connect).toBe('function');
    // This is the whole reason a default import cannot work.
    expect(actual.default).toBeUndefined();
  });

  it('the health controller uses the namespace import, like every other call site', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'health.controller.ts'), 'utf8');
    expect(src).toMatch(/import \* as amqp from 'amqplib'/);
    // A default import here would compile fine and fail at runtime.
    expect(src).not.toMatch(/^import amqp from 'amqplib'/m);
  });
});

// =================================================== the probe behaviour ====

describe('RabbitMQ readiness probe', () => {
  it('calls connect with the configured RABBITMQ_URL and reports ok', async () => {
    const close = jest.fn(async () => undefined);
    connectMock.mockResolvedValue({ close });

    const result = await controller().ready();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith(RABBIT_URL);
    // The probe owns a short-lived connection and must always close it.
    expect(close).toHaveBeenCalledTimes(1);
    expect(result.checks.rabbitmq).toBe('ok');
    expect(result.status).toBe('ready');
  });

  it('reports failed — not a crash — when the broker refuses the connection', async () => {
    connectMock.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    const result = await controller().ready();

    expect(result.checks.rabbitmq).toBe('failed');
    expect(result.status).toBe('not_ready');
  });

  it('would have caught the original defect: a connect that is not a function', async () => {
    // Simulates `amqplib_1.default.connect` being undefined.
    connectMock.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'connect')");
    });

    const result = await controller().ready();
    expect(result.checks.rabbitmq).toBe('failed'); // never crashes the endpoint
  });
});

// ============================================= unchanged health semantics ===

describe('health response semantics are unchanged', () => {
  it('skips RabbitMQ when no URL is configured and nothing requires it', async () => {
    delete process.env.RABBITMQ_URL;
    delete process.env.OUTBOX_RELAY_ENABLED;
    delete process.env.CONSUMERS_ENABLED;
    connectMock.mockResolvedValue({ close: jest.fn() });

    const result = await controller().ready();

    expect(connectMock).not.toHaveBeenCalled();
    expect(result.checks.rabbitmq).toBe('skipped');
    expect(result.status).toBe('ready'); // skipped does not block readiness
  });

  it('fails when RabbitMQ is required but no URL is configured', async () => {
    delete process.env.RABBITMQ_URL;
    process.env.OUTBOX_RELAY_ENABLED = 'true';

    const result = await controller().ready();

    expect(result.checks.rabbitmq).toBe('failed');
    expect(result.status).toBe('not_ready');
  });

  it('still reports the other dependencies independently', async () => {
    connectMock.mockResolvedValue({ close: jest.fn() });

    const mysqlDown = await controller({ mysqlOk: false }).ready();
    expect(mysqlDown.checks.mysql).toBe('failed');
    expect(mysqlDown.checks.rabbitmq).toBe('ok');
    expect(mysqlDown.status).toBe('not_ready');

    const redisDown = await controller({ redisOk: false }).ready();
    expect(redisDown.checks.redis).toBe('failed');
    expect(redisDown.status).toBe('not_ready');
  });

  it('/health stays a static liveness answer', () => {
    const body = controller().health();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.timestamp).toBe('string');
  });
});
