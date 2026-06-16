-- CreateTable
CREATE TABLE `IdempotencyKey` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(36) NOT NULL,
    `idempotencyKey` VARCHAR(255) NOT NULL,
    `requestMethod` VARCHAR(8) NOT NULL,
    `endpoint` VARCHAR(128) NOT NULL,
    `requestFingerprint` VARCHAR(64) NOT NULL,
    `status` ENUM('PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PROCESSING',
    `responseStatusCode` INTEGER NULL,
    `responseBody` JSON NULL,
    `resourceType` VARCHAR(64) NULL,
    `resourceId` VARCHAR(36) NULL,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `IdempotencyKey_expiresAt_idx`(`expiresAt`),
    INDEX `IdempotencyKey_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `IdempotencyKey_userId_idempotencyKey_key`(`userId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
