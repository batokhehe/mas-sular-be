-- Phase 5D: track BUSINESS processing separately from receipt.
--
-- A notification whose authoritative Status API check failed must stay
-- re-processable, so its dedup row exists (receipt) without being terminal
-- (settlement). RECEIVED and VERIFICATION_FAILED are both re-processable;
-- SETTLED and NOT_ELIGIBLE are terminal for that notification.
ALTER TABLE `PaymentWebhookEvent`
  ADD COLUMN `settlementState` ENUM('RECEIVED', 'SETTLED', 'NOT_ELIGIBLE', 'VERIFICATION_FAILED')
    NOT NULL DEFAULT 'RECEIVED';

CREATE INDEX `PaymentWebhookEvent_settlementState_processedAt_idx`
  ON `PaymentWebhookEvent`(`settlementState`, `processedAt`);
