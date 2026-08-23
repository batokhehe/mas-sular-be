// The mock MUST mirror the real amqplib: a CommonJS module exporting `connect` at
// the root, with NO `default`. The previous version declared `__esModule: true` and
// a fabricated `default.connect`, which matched the (broken) default import in the
// controller and is precisely why the runtime failure was never caught here.
jest.mock('amqplib', () => ({ connect: jest.fn() }));
import * as amqp from 'amqplib';
import { HealthController } from '../../src/health.controller';

const mockConnect = amqp.connect as unknown as jest.Mock;

// Readiness answers with an HTTP STATUS CODE as well as a body (F69), so the
// tests hand the controller a minimal Express Response stand-in and read the
// code back. `status()` is the only method the controller touches.
type ResStub = { code: number; status: jest.Mock };
function mockRes(): ResStub {
  const res: ResStub = { code: 0, status: jest.fn() };
  res.status.mockImplementation((code: number) => {
    res.code = code;
    return res;
  });
  return res;
}

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
    const http = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await controller.ready(http as any);
    expect(res).toEqual({ status: 'ready', checks: { mysql: 'ok', redis: 'ok', rabbitmq: 'skipped' } });
    expect(http.code).toBe(200);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('NOT ready when RabbitMQ is required (relay enabled) but no broker URL', async () => {
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    const { controller } = build();
    const http = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await controller.ready(http as any);
    expect(res.checks.rabbitmq).toBe('failed');
    expect(res.status).toBe('not_ready');
    expect(http.code).toBe(503);
  });

  it('NOT ready when the broker URL is set but unreachable', async () => {
    process.env.CONSUMERS_ENABLED = 'true';
    process.env.RABBITMQ_URL = 'amqp://unreachable';
    mockConnect.mockRejectedValue(new Error('ECONNREFUSED'));
    const { controller } = build();
    const http = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await controller.ready(http as any);
    expect(res.checks.rabbitmq).toBe('failed');
    expect(res.status).toBe('not_ready');
    expect(http.code).toBe(503);
  });

  it('ready when the broker is reachable', async () => {
    process.env.CONSUMERS_ENABLED = 'true';
    process.env.RABBITMQ_URL = 'amqp://rabbit';
    mockConnect.mockResolvedValue({ close: jest.fn().mockResolvedValue(undefined) });
    const { controller } = build();
    const http = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await controller.ready(http as any);
    expect(res.checks.rabbitmq).toBe('ok');
    expect(res.status).toBe('ready');
    expect(http.code).toBe(200);
  });

  it('NOT ready when MySQL is down', async () => {
    const { controller } = build({ mysqlOk: false });
    const http = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await controller.ready(http as any);
    expect(res.checks.mysql).toBe('failed');
    expect(res.status).toBe('not_ready');
    expect(http.code).toBe(503);
  });
});

// ================================================ F69: status-code contract ==
//
// Readiness used to answer HTTP 200 unconditionally — a load balancer or
// orchestrator that routes on the status code (they do not parse the body)
// would send traffic to an API with a dead dependency. The code is now the
// signal, and the body detail must survive alongside it.

describe('HealthController.ready — HTTP status code is the readiness signal (F69)', () => {
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

  it('sets 200 exactly once when every required dependency is healthy', async () => {
    const { controller } = build();
    const http = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.ready(http as any);
    expect(http.status).toHaveBeenCalledTimes(1);
    expect(http.status).toHaveBeenCalledWith(200);
  });

  it('sets 503 when MySQL is down, and still returns the per-dependency detail', async () => {
    const { controller } = build({ mysqlOk: false });
    const http = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await controller.ready(http as any);
    expect(http.status).toHaveBeenCalledWith(503);
    // The body is what the runbook reads; 503 must not flatten it away.
    expect(res).toEqual({
      status: 'not_ready',
      checks: { mysql: 'failed', redis: 'ok', rabbitmq: 'skipped' },
    });
  });

  it('sets 503 when Redis is down', async () => {
    const { controller } = build({ redisOk: false });
    const http = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await controller.ready(http as any);
    expect(res.checks.redis).toBe('failed');
    expect(http.code).toBe(503);
  });

  it('a skipped (not required) RabbitMQ still yields 200 — skipped is not a failure', async () => {
    const { controller } = build();
    const http = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await controller.ready(http as any);
    expect(res.checks.rabbitmq).toBe('skipped');
    expect(http.code).toBe(200);
  });

  it('liveness is unaffected — /health and /live never signal dependency state', () => {
    const { controller } = build({ mysqlOk: false, redisOk: false });
    expect(controller.health().status).toBe('ok');
    expect(controller.live()).toEqual({ status: 'live' });
  });
});
