-- AlterTable
ALTER TABLE `IdempotencyKey` ADD COLUMN `fenceToken` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    ADD COLUMN `ownerId` VARCHAR(64) NULL,
    ADD COLUMN `ownershipAcquiredAt` DATETIME(3) NULL;
