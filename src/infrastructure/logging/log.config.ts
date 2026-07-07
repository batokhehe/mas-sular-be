export const LOG_CONFIG = 'LOG_CONFIG';

export interface LogConfig {
  /** Master switch for persisting SystemLog rows. Default on. */
  enabled: boolean;
  /** Rows older than this many days are pruned by the retention worker. */
  retentionDays: number;
  /** Retention worker on/off (independent of persistence). */
  retentionEnabled: boolean;
  /** How often the retention worker runs (default daily). */
  retentionIntervalMs: number;
  /** Delay before the first retention sweep. */
  retentionInitialDelayMs: number;
}

function intOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

export function loadLogConfig(env: NodeJS.ProcessEnv = process.env): LogConfig {
  return {
    enabled: (env.SYSTEM_LOG_ENABLED ?? 'true') !== 'false',
    retentionDays: intOr(env.LOG_RETENTION_DAYS, 90),
    retentionEnabled: (env.SYSTEM_LOG_RETENTION_ENABLED ?? 'true') !== 'false',
    retentionIntervalMs: intOr(env.LOG_RETENTION_INTERVAL_MS, 24 * 60 * 60 * 1000),
    retentionInitialDelayMs: intOr(env.LOG_RETENTION_INITIAL_DELAY_MS, 60 * 1000),
  };
}
