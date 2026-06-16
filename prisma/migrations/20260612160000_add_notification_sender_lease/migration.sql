-- AlterTable
ALTER TABLE `NotificationOutbox` ADD COLUMN `lockedBy` VARCHAR(64) NULL,
    ADD COLUMN `lockedUntil` DATETIME(3) NULL,
    ADD COLUMN `providerMessageId` VARCHAR(255) NULL;
