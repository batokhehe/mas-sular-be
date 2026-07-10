-- P0-1 (database audit D1): Shipment had only the orderId unique; every
-- status-based worker query (tracking poll, sync sweep, reconciliation
-- candidates, booking-claim CAS) was a full table scan. Additive only.
CREATE INDEX `Shipment_status_updatedAt_idx` ON `Shipment`(`status`, `updatedAt`);
