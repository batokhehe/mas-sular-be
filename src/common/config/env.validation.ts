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

  // RabbitMQ required whenever the relay or consumers are enabled.
  if ((env.OUTBOX_RELAY_ENABLED === 'true' || env.CONSUMERS_ENABLED === 'true') && !env.RABBITMQ_URL) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['RABBITMQ_URL'], message: 'RABBITMQ_URL is required when OUTBOX_RELAY_ENABLED or CONSUMERS_ENABLED is true' });
  }

  // Resend credentials required when the sender is enabled.
  if (env.NOTIFICATION_SENDER_ENABLED === 'true') {
    if (!env.RESEND_API_KEY) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['RESEND_API_KEY'], message: 'RESEND_API_KEY is required when NOTIFICATION_SENDER_ENABLED=true' });
    if (!env.EMAIL_FROM) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['EMAIL_FROM'], message: 'EMAIL_FROM is required when NOTIFICATION_SENDER_ENABLED=true' });
  }

  // Browsers reject SameSite=None cookies unless they are also Secure.
  if (env.COOKIE_SAMESITE === 'none' && env.COOKIE_SECURE !== 'true') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['COOKIE_SECURE'], message: 'COOKIE_SECURE must be "true" when COOKIE_SAMESITE=none' });
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
