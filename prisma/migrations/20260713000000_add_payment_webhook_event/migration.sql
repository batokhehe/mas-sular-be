-- Phase 5C: durable, idempotent gateway webhook processing.

-- 1) Verbatim provider status on the attempt ledger. Additive and nullable, so every
--    existing row stays valid; no backfill is possible or needed (historical rows
--    predate webhook processing).
ALTER TABLE `PaymentGatewayTransaction`
  ADD COLUMN `providerStatus` VARCHAR(32) NULL,
  ADD COLUMN `providerStatusAt` DATETIME(3) NULL;

-- 2) Append-only ledger of verified notifications. `fingerprint` UNIQUE is the
--    deduplication invariant: concurrent duplicate deliveries collide here, in the
--    database, rather than relying on a read-then-write check in the application.
CREATE TABLE `PaymentWebhookEvent` (
  `id` VARCHAR(191) NOT NULL,
  `provider` VARCHAR(32) NOT NULL,
  `fingerprint` VARCHAR(64) NOT NULL,
  `providerOrderId` VARCHAR(128) NOT NULL,
  `providerTransactionId` VARCHAR(128) NULL,
  `transactionStatus` VARCHAR(32) NULL,
  `statusCode` VARCHAR(8) NULL,
  `fraudStatus` VARCHAR(32) NULL,
  `grossAmount` VARCHAR(32) NOT NULL,
  `gatewayTransactionId` VARCHAR(36) NULL,
  `payload` JSON NULL,
  `notifiedAt` DATETIME(3) NULL,
  `processedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `PaymentWebhookEvent_fingerprint_key`(`fingerprint`),
  INDEX `PaymentWebhookEvent_provider_providerOrderId_processedAt_idx`(`provider`, `providerOrderId`, `processedAt`),
  INDEX `PaymentWebhookEvent_processedAt_idx`(`processedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
