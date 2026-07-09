-- CreateTable
-- Additive: enterprise audit trail of human admin actions. No existing table changes.
CREATE TABLE `AuditTrail` (
    `id` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `adminId` VARCHAR(36) NULL,
    `adminName` VARCHAR(255) NULL,
    `ipAddress` VARCHAR(64) NULL,
    `userAgent` VARCHAR(512) NULL,
    `requestId` VARCHAR(64) NULL,
    `module` VARCHAR(64) NOT NULL,
    `entity` VARCHAR(64) NOT NULL,
    `entityId` VARCHAR(64) NULL,
    `entityName` VARCHAR(255) NULL,
    `action` VARCHAR(48) NOT NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `diff` JSON NULL,
    `metadata` JSON NULL,
    `success` BOOLEAN NOT NULL DEFAULT true,

    INDEX `AuditTrail_createdAt_idx`(`createdAt`),
    INDEX `AuditTrail_module_createdAt_idx`(`module`, `createdAt`),
    INDEX `AuditTrail_entity_entityId_idx`(`entity`, `entityId`),
    INDEX `AuditTrail_adminId_createdAt_idx`(`adminId`, `createdAt`),
    INDEX `AuditTrail_requestId_idx`(`requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
