-- CreateTable
-- Additive structured log sink. No existing table is modified.
CREATE TABLE `SystemLog` (
    `id` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `level` ENUM('DEBUG', 'INFO', 'WARN', 'ERROR') NOT NULL DEFAULT 'INFO',
    `module` VARCHAR(64) NOT NULL,
    `action` VARCHAR(96) NOT NULL,
    `message` TEXT NOT NULL,
    `requestId` VARCHAR(64) NULL,
    `userId` VARCHAR(36) NULL,
    `adminId` VARCHAR(36) NULL,
    `orderId` VARCHAR(36) NULL,
    `paymentId` VARCHAR(36) NULL,
    `shipmentId` VARCHAR(36) NULL,
    `inventoryReservationId` VARCHAR(36) NULL,
    `ip` VARCHAR(64) NULL,
    `method` VARCHAR(8) NULL,
    `path` VARCHAR(512) NULL,
    `statusCode` INTEGER NULL,
    `durationMs` INTEGER NULL,
    `metadata` JSON NULL,

    INDEX `SystemLog_createdAt_idx`(`createdAt`),
    INDEX `SystemLog_level_createdAt_idx`(`level`, `createdAt`),
    INDEX `SystemLog_module_createdAt_idx`(`module`, `createdAt`),
    INDEX `SystemLog_statusCode_createdAt_idx`(`statusCode`, `createdAt`),
    INDEX `SystemLog_requestId_idx`(`requestId`),
    INDEX `SystemLog_orderId_idx`(`orderId`),
    INDEX `SystemLog_paymentId_idx`(`paymentId`),
    INDEX `SystemLog_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
