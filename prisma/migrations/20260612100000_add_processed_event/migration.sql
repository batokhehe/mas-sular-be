-- CreateTable
CREATE TABLE `ProcessedEvent` (
    `consumer` VARCHAR(64) NOT NULL,
    `messageId` VARCHAR(36) NOT NULL,
    `eventName` VARCHAR(128) NOT NULL,
    `processedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProcessedEvent_processedAt_idx`(`processedAt`),
    PRIMARY KEY (`consumer`, `messageId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
