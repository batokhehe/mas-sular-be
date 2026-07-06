export const SHIPMENT_RECONCILIATION_CONFIG = 'SHIPMENT_RECONCILIATION_CONFIG';

export interface ShipmentReconciliationConfig {
  /** Master switch. Defaults to false; enable via SHIPMENT_RECONCILIATION_ENABLED=true. */
  enabled: boolean;
  pollIntervalMs: number;
  initialDelayMs: number;
  batchSize: number;
  /** Grace period after checkout before an un-booked shipment is reconciled. Also the
   *  reclaim threshold for a shipment left mid-claim by a crashed reconciliation run. */
  delayMs: number;
  healthLogIntervalMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function loadShipmentReconciliationConfig(env: NodeJS.ProcessEnv = process.env): ShipmentReconciliationConfig {
  return {
    enabled: env.SHIPMENT_RECONCILIATION_ENABLED === 'true',
    pollIntervalMs: positiveInt(env.SHIPMENT_RECONCILIATION_INTERVAL_MS, 60_000),
    initialDelayMs: positiveInt(env.SHIPMENT_RECONCILIATION_INITIAL_DELAY_MS, 30_000),
    batchSize: positiveInt(env.SHIPMENT_RECONCILIATION_BATCH_SIZE, 50),
    delayMs: positiveInt(env.SHIPMENT_RECONCILIATION_DELAY_MS, 2 * 60_000),
    healthLogIntervalMs: positiveInt(env.SHIPMENT_RECONCILIATION_HEALTH_LOG_MS, 5 * 60_000),
  };
}
