export const LIFECYCLE_CONFIG = 'LIFECYCLE_CONFIG';

export interface LifecycleConfig {
  /** Master switch. Defaults to false; enable via RETENTION_ENABLED=true. */
  enabled: boolean;
  /** When true, count would-delete rows and log; perform NO deletes. */
  dryRun: boolean;
  /** Rows deleted per batched DELETE statement. */
  batchSize: number;
  /** Interval between full retention runs. */
  intervalMs: number;
  /** Delay before the first run after bootstrap. */
  initialDelayMs: number;
  /** Safety cap on batches per policy per run (prevents an unbounded loop). */
  maxBatchesPerPolicy: number;

  // Windows (days)
  outboxPublishedDays: number; // OutboxEvent status=PUBLISHED
  outboxFailedDays: number; // OutboxEvent status=FAILED (retained long)
  processedDays: number; // ProcessedEvent
  notificationSentDays: number; // NotificationOutbox status=SENT (by sentAt)
  notificationFailedDays: number; // NotificationOutbox status=FAILED (retained long)
  uploadTokenExpiredDays: number; // PaymentUploadToken, retained N days AFTER expiresAt
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function loadLifecycleConfig(env: NodeJS.ProcessEnv = process.env): LifecycleConfig {
  return {
    enabled: env.RETENTION_ENABLED === 'true',
    dryRun: env.RETENTION_DRY_RUN === 'true',
    batchSize: positiveInt(env.RETENTION_BATCH_SIZE, 1_000),
    intervalMs: positiveInt(env.RETENTION_INTERVAL_MS, 24 * 60 * 60 * 1000), // daily
    initialDelayMs: positiveInt(env.RETENTION_INITIAL_DELAY_MS, 60_000),
    maxBatchesPerPolicy: positiveInt(env.RETENTION_MAX_BATCHES, 1_000),
    outboxPublishedDays: positiveInt(env.RETENTION_OUTBOX_PUBLISHED_DAYS, 7),
    outboxFailedDays: positiveInt(env.RETENTION_OUTBOX_FAILED_DAYS, 90),
    processedDays: positiveInt(env.RETENTION_PROCESSED_DAYS, 30),
    notificationSentDays: positiveInt(env.RETENTION_NOTIFICATION_SENT_DAYS, 30),
    notificationFailedDays: positiveInt(env.RETENTION_NOTIFICATION_FAILED_DAYS, 90),
    uploadTokenExpiredDays: positiveInt(env.RETENTION_UPLOAD_TOKEN_DAYS, 14),
  };
}
