import { z } from 'zod';

/** Known hardcoded development secrets that must never be used as real secrets. */
const INSECURE_SECRETS = new Set(['development-only-secret', 'development-only-admin-secret']);

const HOUR_MS = 60 * 60 * 1000;

const boolFlag = z.enum(['true', 'false']).default('false');

const secret = z
  .string()
  .min(32, 'must be at least 32 characters')
  .refine((v) => !INSECURE_SECRETS.has(v), 'must not be a known insecure development secret');

const baseSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().optional(),

    // Core infrastructure (always required)
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

    // Auth secrets — no hardcoded fallbacks; min length enforced in every environment.
    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    JWT_ADMIN_ACCESS_SECRET: secret,
    GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),

    // Upload URLs
    APP_URL: z.string().url('APP_URL must be a valid URL'),
    PAYMENT_UPLOAD_BASE_URL: z.string().url('PAYMENT_UPLOAD_BASE_URL must be a valid URL').optional(),

    // CORS — validated cross-field below (required in non-local, no wildcard)
    CORS_ORIGINS: z.string().optional(),

    // Async pipeline toggles + their conditionally-required settings
    OUTBOX_RELAY_ENABLED: boolFlag,
    CONSUMERS_ENABLED: boolFlag,
    RABBITMQ_URL: z.string().optional(),

    NOTIFICATION_SENDER_ENABLED: boolFlag,
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    ADMIN_NOTIFICATION_EMAIL: z.string().email('ADMIN_NOTIFICATION_EMAIL must be a valid email').optional(),

    // Payment lifecycle windows — ordering validated cross-field below
    PAYMENT_LIFECYCLE_ENABLED: boolFlag,
    PAYMENT_FIRST_REMINDER_MS: z.coerce.number().int().positive().optional(),
    PAYMENT_SECOND_REMINDER_MS: z.coerce.number().int().positive().optional(),
    PAYMENT_EXPIRY_MS: z.coerce.number().int().positive().optional(),
    PAYMENT_GATEWAY_EXPIRY_MS: z.coerce.number().int().nonnegative().optional(),

    // Phase 13A — httpOnly auth cookies. All optional; cookie behavior is env-driven.
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: z.enum(['true', 'false']).optional(),
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).optional(),
    // Phase 13A.4 — gates the JWT cookie extractors. Default false → behavior is
    // identical to pre-13A.4 production (Bearer-only). Flip to true to accept cookies.
    AUTH_COOKIE_EXTRACTOR_ENABLED: boolFlag,
    // Phase 13A.6 — stateless double-submit CSRF rollout. off (default) → no
    // validation, report → log-only, enforce → 403 on mismatch.
    CSRF_MODE: z.enum(['off', 'report', 'enforce']).default('off'),

    // WhatsApp (Mekari Qontak) notifications. Required (cross-field below) only when
    // the sender is enabled and the provider routes WhatsApp. No bank data in env.
    NOTIFICATION_PROVIDER: z.enum(['multi', 'email', 'qontak']).default('multi'),
    QONTAK_API_TOKEN: z.string().optional(),
    QONTAK_CHANNEL_INTEGRATION_ID: z.string().optional(),
    QONTAK_ORDER_TEMPLATE_ID: z.string().optional(),
    QONTAK_COD_TEMPLATE_ID: z.string().optional(),
    QONTAK_BASE_URL: z.string().url('QONTAK_BASE_URL must be a valid URL').optional(),
    QONTAK_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    QONTAK_MAX_RETRY: z.coerce.number().int().nonnegative().optional(),

    // Shipping providers (Paxel / JNE). Disabled by default; credentials are
    // required (cross-field below) only when the provider is enabled.
    SHIPPING_ORIGIN_POSTAL_CODE: z.string().optional(),
    PAXEL_ENABLED: boolFlag,
    PAXEL_BASE_URL: z.string().optional(),
    PAXEL_API_KEY: z.string().optional(),
    PAXEL_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    PAXEL_MAX_RETRY: z.coerce.number().int().nonnegative().optional(),
    JNE_ENABLED: boolFlag,
    JNE_BASE_URL: z.string().optional(),
    JNE_API_KEY: z.string().optional(),
    JNE_USERNAME: z.string().optional(),
    JNE_ORIGIN_CODE: z.string().optional(),
    JNE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    JNE_MAX_RETRY: z.coerce.number().int().nonnegative().optional(),

    // Checkout idempotency. Optional locally; MUST be true in staging/production
    // (cross-field below) so duplicate checkout requests can never double-create.
    CHECKOUT_IDEMPOTENCY_ENABLED: boolFlag,

    // Manual BANK_TRANSFER unique code. Disabled by default → behavior identical to
    // before. Range invariants (min >= 0, max <= 999, max > min) checked cross-field.
    PAYMENT_UNIQUE_CODE_ENABLED: boolFlag,
    PAYMENT_UNIQUE_CODE_MIN: z.coerce.number().int().optional(),
    PAYMENT_UNIQUE_CODE_MAX: z.coerce.number().int().optional(),

    // Enterprise logging center (additive). All optional; persistence + retention
    // default on with a 90-day window.
    SYSTEM_LOG_ENABLED: boolFlag.optional(),
    SYSTEM_LOG_RETENTION_ENABLED: boolFlag.optional(),
    LOG_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  })
  .passthrough(); // tolerate the many optional tuning vars (OUTBOX_*, NOTIFICATION_SENDER_*, RETENTION_*, ...)

export const envSchema = baseSchema.superRefine((env, ctx) => {
  const isLocal = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';

  // CORS: explicit allowlist only; required outside local; no reflect-all wildcard.
  const corsList = (env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!isLocal && corsList.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ORIGINS'], message: 'CORS_ORIGINS must list at least one explicit origin in staging/production' });
  }
  if (corsList.includes('*')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ORIGINS'], message: 'wildcard "*" origin is not allowed with credentialed CORS' });
  }

  // M5: checkout idempotency must be enabled outside local (staging/production), so a
  // duplicate/retried checkout can never create duplicate orders/payments/reservations.
  // Development and test may disable it; staging follows production.
  if (!isLocal && env.CHECKOUT_IDEMPOTENCY_ENABLED !== 'true') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CHECKOUT_IDEMPOTENCY_ENABLED'],
      message: 'CHECKOUT_IDEMPOTENCY_ENABLED must be "true" in staging/production',
    });
  }

  // RabbitMQ required whenever the relay or consumers are enabled.
  if ((env.OUTBOX_RELAY_ENABLED === 'true' || env.CONSUMERS_ENABLED === 'true') && !env.RABBITMQ_URL) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['RABBITMQ_URL'], message: 'RABBITMQ_URL is required when OUTBOX_RELAY_ENABLED or CONSUMERS_ENABLED is true' });
  }

  // Resend credentials required when the sender is enabled.
  if (env.NOTIFICATION_SENDER_ENABLED === 'true') {
    if (!env.RESEND_API_KEY) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['RESEND_API_KEY'], message: 'RESEND_API_KEY is required when NOTIFICATION_SENDER_ENABLED=true' });
    if (!env.EMAIL_FROM) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['EMAIL_FROM'], message: 'EMAIL_FROM is required when NOTIFICATION_SENDER_ENABLED=true' });

    // Qontak credentials required when WhatsApp is routable (provider multi|qontak).
    const provider = (env.NOTIFICATION_PROVIDER as string | undefined) ?? 'multi';
    if (provider !== 'email') {
      for (const key of ['QONTAK_API_TOKEN', 'QONTAK_CHANNEL_INTEGRATION_ID', 'QONTAK_ORDER_TEMPLATE_ID', 'QONTAK_COD_TEMPLATE_ID'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when NOTIFICATION_SENDER_ENABLED=true and NOTIFICATION_PROVIDER=${provider}` });
        }
      }
    }
  }

  // Shipping providers: credentials are required when the provider is enabled.
  if (env.PAXEL_ENABLED === 'true' && !env.PAXEL_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAXEL_API_KEY'], message: 'PAXEL_API_KEY is required when PAXEL_ENABLED=true' });
  }
  if (env.JNE_ENABLED === 'true') {
    for (const key of ['JNE_API_KEY', 'JNE_USERNAME', 'JNE_ORIGIN_CODE'] as const) {
      if (!env[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when JNE_ENABLED=true` });
      }
    }
  }

  // Browsers reject SameSite=None cookies unless they are also Secure.
  if (env.COOKIE_SAMESITE === 'none' && env.COOKIE_SECURE !== 'true') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['COOKIE_SECURE'], message: 'COOKIE_SECURE must be "true" when COOKIE_SAMESITE=none' });
  }

  // Unique-code range invariants (only meaningful when the feature is enabled, but
  // validated whenever provided so a bad range never reaches the generator).
  const codeMin = env.PAYMENT_UNIQUE_CODE_MIN ?? 100;
  const codeMax = env.PAYMENT_UNIQUE_CODE_MAX ?? 999;
  if (codeMin < 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAYMENT_UNIQUE_CODE_MIN'], message: 'PAYMENT_UNIQUE_CODE_MIN must be >= 0' });
  }
  if (codeMax > 999) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAYMENT_UNIQUE_CODE_MAX'], message: 'PAYMENT_UNIQUE_CODE_MAX must be <= 999' });
  }
  if (!(codeMax > codeMin)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAYMENT_UNIQUE_CODE_MAX'], message: 'PAYMENT_UNIQUE_CODE_MAX must be greater than PAYMENT_UNIQUE_CODE_MIN' });
  }

  // Payment timing must be strictly increasing so reminders precede expiry.
  // Defaults mirror payment-lifecycle.config (12h / 20h / 24h).
  const first = env.PAYMENT_FIRST_REMINDER_MS ?? 12 * HOUR_MS;
  const second = env.PAYMENT_SECOND_REMINDER_MS ?? 20 * HOUR_MS;
  const expiry = env.PAYMENT_EXPIRY_MS ?? 24 * HOUR_MS;
  if (!(first < second && second < expiry)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PAYMENT_EXPIRY_MS'],
      message: `payment windows must satisfy FIRST_REMINDER (${first}) < SECOND_REMINDER (${second}) < EXPIRY (${expiry}) ms`,
    });
  }
});

/**
 * ConfigModule `validate` hook. Throws a single aggregated error (fail-fast) when
 * any environment variable is missing/invalid, so the app never boots in a
 * dangerous configuration.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => ` - ${issue.path.join('.') || '(env)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
