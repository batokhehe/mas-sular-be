import { loadConsumersConfig } from '../../src/infrastructure/consumers/consumers.config';

describe('loadConsumersConfig', () => {
  it('defaults enabled to false and applies sane defaults', () => {
    const cfg = loadConsumersConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.prefetch).toBe(10);
    expect(cfg.maxAttempts).toBe(5);
    expect(cfg.retryDelayMs).toBe(30_000);
    expect(cfg.rabbitmqUrl).toBeUndefined();
  });

  it('parses overrides from env', () => {
    const cfg = loadConsumersConfig({
      CONSUMERS_ENABLED: 'true',
      RABBITMQ_URL: 'amqp://x',
      CONSUMER_PREFETCH: '25',
      CONSUMER_MAX_ATTEMPTS: '8',
      CONSUMER_RETRY_DELAY_MS: '5000',
    });
    expect(cfg).toEqual({
      enabled: true,
      rabbitmqUrl: 'amqp://x',
      prefetch: 25,
      maxAttempts: 8,
      retryDelayMs: 5000,
    });
  });

  it('falls back to defaults for non-positive/invalid numbers', () => {
    const cfg = loadConsumersConfig({ CONSUMER_PREFETCH: '0', CONSUMER_MAX_ATTEMPTS: 'abc' });
    expect(cfg.prefetch).toBe(10);
    expect(cfg.maxAttempts).toBe(5);
  });
});
