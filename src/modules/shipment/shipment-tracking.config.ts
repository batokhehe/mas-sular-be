import { positiveInt } from '../../common/utils/number.util';
export const SHIPMENT_TRACKING_CONFIG = 'SHIPMENT_TRACKING_CONFIG';

export interface ShipmentTrackingConfig {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
}

export function loadShipmentTrackingConfig(env: NodeJS.ProcessEnv = process.env): ShipmentTrackingConfig {
  return {
    enabled: env.SHIPMENT_TRACKING_ENABLED === 'true',
    pollIntervalMs: positiveInt(env.SHIPMENT_TRACKING_POLL_INTERVAL_MS, 300_000),
    batchSize: positiveInt(env.SHIPMENT_TRACKING_BATCH_SIZE, 50),
  };
}
