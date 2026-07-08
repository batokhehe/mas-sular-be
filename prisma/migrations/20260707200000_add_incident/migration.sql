-- CreateTable
-- Additive: auto-detected operational incidents (Incident Center). No existing table changes.
CREATE TABLE `Incident` (
    `id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `severity` ENUM('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL') NOT NULL DEFAULT 'MEDIUM',
    `status` ENUM('OPEN', 'ACKNOWLEDGED', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NOT NULL,
    `source` VARCHAR(64) NOT NULL,
    `requestId` VARCHAR(64) NULL,
    `orderId` VARCHAR(36) NULL,
    `paymentId` VARCHAR(36) NULL,
    `shipmentId` VARCHAR(36) NULL,
    `worker` VARCHAR(64) NULL,
    `module` VARCHAR(64) NULL,
    `count` INTEGER NOT NULL DEFAULT 1,
    `firstSeen` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeen` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `acknowledgedAt` DATETIME(3) NULL,
    `acknowledgedBy` VARCHAR(36) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `resolvedBy` VARCHAR(36) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Incident_status_severity_lastSeen_idx`(`status`, `severity`, `lastSeen`),
    INDEX `Incident_type_status_idx`(`type`, `status`),
    INDEX `Incident_source_createdAt_idx`(`source`, `createdAt`),
    INDEX `Incident_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
