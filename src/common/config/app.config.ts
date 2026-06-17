const INSECURE_SECRETS = new Set(['development-only-secret', 'development-only-admin-secret']);

const assertProductionSecrets = () => {
  if (process.env.NODE_ENV !== 'production') return;

  const required: Record<string, string | undefined> = {
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
    JWT_ADMIN_ACCESS_SECRET: process.env.JWT_ADMIN_ACCESS_SECRET,
  };

  const invalid = Object.entries(required)
    .filter(([, value]) => !value || value.length < 32 || INSECURE_SECRETS.has(value))
    .map(([key]) => key);

  if (invalid.length > 0) {
    throw new Error(
      `Refusing to start in production: missing or insecure secrets -> ${invalid.join(', ')}. ` +
        'Set each to a unique value of at least 32 characters.',
    );
  }
};

export const appConfig = () => {
  assertProductionSecrets();

  return {
    port: Number(process.env.PORT ?? 3001),
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    rabbitmqUrl: process.env.RABBITMQ_URL,
    jwt: {
      accessSecret: process.env.JWT_ACCESS_SECRET,
      refreshSecret: process.env.JWT_REFRESH_SECRET,
      adminAccessSecret: process.env.JWT_ADMIN_ACCESS_SECRET,
      adminAccessTtl: process.env.JWT_ADMIN_ACCESS_TTL ?? '1d',
      accessTtl: process.env.JWT_ACCESS_TTL ?? '1d',
      refreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
    },
  };
};