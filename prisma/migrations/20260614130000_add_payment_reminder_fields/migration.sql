-- AlterTable
ALTER TABLE `Payment` ADD COLUMN `firstReminderAt` DATETIME(3) NULL,
    ADD COLUMN `secondReminderAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Payment_status_method_createdAt_idx` ON `Payment`(`status`, `method`, `createdAt`);
