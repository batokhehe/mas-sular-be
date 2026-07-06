-- AlterTable
ALTER TABLE `Order` ADD COLUMN `shippingCost` INTEGER NULL,
    ADD COLUMN `shippingPayload` JSON NULL,
    ADD COLUMN `shippingProvider` VARCHAR(191) NULL,
    ADD COLUMN `shippingService` VARCHAR(191) NULL,
    ADD COLUMN `shippingServiceName` VARCHAR(191) NULL,
    ADD COLUMN `trackingNumber` VARCHAR(191) NULL;

