-- CreateTable
CREATE TABLE `OutboxEvent` (
    `id` VARCHAR(191) NOT NULL,
    `aggregateType` VARCHAR(32) NOT NULL,
    `aggregateId` VARCHAR(36) NOT NULL,
    `eventName` VARCHAR(128) NOT NULL,
    `eventVersion` INTEGER NOT NULL DEFAULT 1,
    `exchange` VARCHAR(128) NOT NULL,
    `routingKey` VARCHAR(128) NOT NULL,
    `payload` JSON NOT NULL,
    `metadata` JSON NULL,
    `status` ENUM('PENDING', 'PUBLISHED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER UNSIGNED NOT NULL DEFAULT 10,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lockedUntil` DATETIME(3) NULL,
    `lockedBy` VARCHAR(64) NULL,
    `lastError` TEXT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `publishedAt` DATETIME(3) NULL,

    INDEX `OutboxEvent_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `OutboxEvent_aggregateId_createdAt_idx`(`aggregateId`, `createdAt`),
    INDEX `OutboxEvent_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
