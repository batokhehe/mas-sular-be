-- AlterTable
-- Additive, nullable column: legacy payments keep uniqueCode = NULL and continue working.
ALTER TABLE `Payment` ADD COLUMN `uniqueCode` INTEGER NULL;
