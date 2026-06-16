import { validateEnv } from '../../src/common/config/env.validation';

const VALID: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'mysql://u:p@db:3306/app',
  REDIS_URL: 'redis://redis:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  JWT_ADMIN_ACCESS_SECRET: 'c'.repeat(32),
  GOOGLE_CLIENT_ID: 'google-client-id',
  APP_URL: 'https://shop.example.com',
  CORS_ORIGINS: 'https://shop.example.com',
};

const valid = (over: Record<string, string | undefined> = {}) => ({ ...VALID, ...over });

describe('validateEnv', () => {
  it('accepts a complete, valid production config', () => {
    expect(() => validateEnv(valid())).not.toThrow();
  });

  it('fails fast on missing core infrastructure', () => {
    expect(() => validateEnv(valid({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL/);
    expect(() => validateEnv(valid({ REDIS_URL: undefined }))).toThrow(/REDIS_URL/);
  });

  describe('secrets', () => {
    it('rejects short secrets (< 32 chars)', () => {
      expect(() => validateEnv(valid({ JWT_ACCESS_SECRET: 'short' }))).toThrow(/JWT_ACCESS_SECRET/);
    });
    it('rejects the known insecure development secrets', () => {
      expect(() => validateEnv(valid({ JWT_ACCESS_SECRET: 'development-only-secret' }))).toThrow(/JWT_ACCESS_SECRET/);
      expect(() => validateEnv(valid({ JWT_ADMIN_ACCESS_SECRET: 'development-only-admin-secret' }))).toThrow(/JWT_ADMIN_ACCESS_SECRET/);
    });
    it('requires GOOGLE_CLIENT_ID', () => {
      expect(() => validateEnv(valid({ GOOGLE_CLIENT_ID: undefined }))).toThrow(/GOOGLE_CLIENT_ID/);
    });
  });

  describe('CORS', () => {
    it('requires a non-empty allowlist in staging/production', () => {
      expect(() => validateEnv(valid({ CORS_ORIGINS: '' }))).toThrow(/CORS_ORIGINS/);
      expect(() => validateEnv(valid({ NODE_ENV: 'staging', CORS_ORIGINS: undefined }))).toThrow(/CORS_ORIGINS/);
    });
    it('allows an empty allowlist locally', () => {
      expect(() => validateEnv(valid({ NODE_ENV: 'development', CORS_ORIGINS: '' }))).not.toThrow();
    });
    it('rejects a wildcard origin (no reflect-all with credentials)', () => {
      expect(() => validateEnv(valid({ CORS_ORIGINS: '*' }))).toThrow(/wildcard/);
    });
  });

  describe('URLs', () => {
    it('requires a valid APP_URL', () => {
      expect(() => validateEnv(valid({ APP_URL: 'not-a-url' }))).toThrow(/APP_URL/);
    });
    it('validates PAYMENT_UPLOAD_BASE_URL when present', () => {
      expect(() => validateEnv(valid({ PAYMENT_UPLOAD_BASE_URL: 'nope' }))).toThrow(/PAYMENT_UPLOAD_BASE_URL/);
      expect(() => validateEnv(valid({ PAYMENT_UPLOAD_BASE_URL: 'https://shop.example.com' }))).not.toThrow();
    });
  });

  describe('RabbitMQ requirement', () => {
    it('requires RABBITMQ_URL when the relay is enabled', () => {
      expect(() => validateEnv(valid({ OUTBOX_RELAY_ENABLED: 'true' }))).toThrow(/RABBITMQ_URL/);
    });
    it('requires RABBITMQ_URL when consumers are enabled', () => {
      expect(() => validateEnv(valid({ CONSUMERS_ENABLED: 'true' }))).toThrow(/RABBITMQ_URL/);
    });
    it('passes when the broker URL is provided', () => {
      expect(() => validateEnv(valid({ CONSUMERS_ENABLED: 'true', RABBITMQ_URL: 'amqp://rabbit' }))).not.toThrow();
    });
  });

  describe('notification sender requirement', () => {
    it('requires Resend credentials when the sender is enabled', () => {
      expect(() => validateEnv(valid({ NOTIFICATION_SENDER_ENABLED: 'true' }))).toThrow(/RESEND_API_KEY|EMAIL_FROM/);
    });
    it('passes when the sender credentials are provided', () => {
      expect(() =>
        validateEnv(valid({ NOTIFICATION_SENDER_ENABLED: 'true', RESEND_API_KEY: 'rk', EMAIL_FROM: 'orders@x.test' })),
      ).not.toThrow();
    });
  });

  describe('payment timing', () => {
    it('rejects non-increasing windows', () => {
      expect(() => validateEnv(valid({ PAYMENT_FIRST_REMINDER_MS: '5000', PAYMENT_SECOND_REMINDER_MS: '4000' }))).toThrow(/payment windows/);
      expect(() => validateEnv(valid({ PAYMENT_SECOND_REMINDER_MS: '999999999', PAYMENT_EXPIRY_MS: '1000' }))).toThrow(/payment windows/);
    });
    it('accepts strictly increasing windows and the defaults', () => {
      expect(() => validateEnv(valid())).not.toThrow(); // defaults 24h<48h<72h
      expect(() =>
        validateEnv(valid({ PAYMENT_FIRST_REMINDER_MS: '1000', PAYMENT_SECOND_REMINDER_MS: '2000', PAYMENT_EXPIRY_MS: '3000' })),
      ).not.toThrow();
    });
  });
});
