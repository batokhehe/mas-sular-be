-- Phase 2 (payment gateway persistence): append-only ledger of gateway charge
-- attempts and provider responses. Fully additive — no existing table or column
-- is altered, so the running manual-transfer flow is unaffected.
CREATE TABLE `PaymentGatewayTransaction` (
    `id` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `channelCode` VARCHAR(32) NOT NULL,
    `providerReference` VARCHAR(128) NULL,
    `providerOrderId` VARCHAR(128) NULL,
    `providerTransactionId` VARCHAR(128) NULL,
    `status` ENUM('PENDING', 'AUTHORIZED', 'CAPTURED', 'SETTLEMENT', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
    `grossAmount` INTEGER NOT NULL,
    `currency` VARCHAR(3) NOT NULL DEFAULT 'IDR',
    `redirectUrl` VARCHAR(512) NULL,
    `deeplinkUrl` VARCHAR(512) NULL,
    `qrString` TEXT NULL,
    `vaNumber` VARCHAR(64) NULL,
    `expiryAt` DATETIME(3) NULL,
    `rawRequest` JSON NULL,
    `rawResponse` JSON NULL,
    `metadata` JSON NULL,
    `failureReason` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    -- Idempotency anchor for the future webhook receiver. MySQL permits multiple
    -- NULLs, so PENDING rows (provider id not yet known) never collide.
    UNIQUE INDEX `PaymentGatewayTransaction_provider_providerTransactionId_key`(`provider`, `providerTransactionId`),
    INDEX `PaymentGatewayTransaction_paymentId_createdAt_idx`(`paymentId`, `createdAt`),
    INDEX `PaymentGatewayTransaction_provider_providerReference_idx`(`provider`, `providerReference`),
    INDEX `PaymentGatewayTransaction_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `PaymentGatewayTransaction_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Cascade mirrors Payment's other children (Transaction, PaymentUploadToken).
ALTER TABLE `PaymentGatewayTransaction`
  ADD CONSTRAINT `PaymentGatewayTransaction_paymentId_fkey`
  FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
