import { positiveInt } from '../../common/utils/number.util';
export const INVENTORY_RESERVATION_CONFIG = 'INVENTORY_RESERVATION_CONFIG';

export interface InventoryReservationConfig {
  /** Master switch. Defaults to false; enable via INVENTORY_RESERVATION_WORKER_ENABLED=true. */
  enabled: boolean;
  pollIntervalMs: number;
  initialDelayMs: number;
  batchSize: number;
  healthLogIntervalMs: number;
}

export function loadInventoryReservationConfig(env: NodeJS.ProcessEnv = process.env): InventoryReservationConfig {
  return {
    enabled: env.INVENTORY_RESERVATION_WORKER_ENABLED === 'true',
    pollIntervalMs: positiveInt(env.INVENTORY_RESERVATION_POLL_MS, 60 * 1000),
    initialDelayMs: positiveInt(env.INVENTORY_RESERVATION_INITIAL_DELAY_MS, 30 * 1000),
    batchSize: positiveInt(env.INVENTORY_RESERVATION_BATCH_SIZE, 100),
    healthLogIntervalMs: positiveInt(env.INVENTORY_RESERVATION_HEALTH_LOG_MS, 5 * 60 * 1000),
  };
}
