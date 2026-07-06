-- AlterTable
ALTER TABLE `Order` ADD COLUMN `coverageId` VARCHAR(191) NULL,
    ADD COLUMN `estimatedDeliveryMinutes` INTEGER NULL;

-- CreateTable
CREATE TABLE `DeliveryCoverage` (
    `id` VARCHAR(191) NOT NULL,
    `provinceId` VARCHAR(191) NOT NULL,
    `cityId` VARCHAR(191) NOT NULL,
    `districtId` VARCHAR(191) NULL,
    `villageId` VARCHAR(191) NULL,
    `coverageType` ENUM('DELIVERY', 'PICKUP_ONLY', 'DISABLED') NOT NULL DEFAULT 'DELIVERY',
    `deliveryFee` INTEGER NOT NULL DEFAULT 0,
    `minimumOrder` INTEGER NOT NULL DEFAULT 0,
    `estimatedMinutes` INTEGER NOT NULL DEFAULT 60,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `DeliveryCoverage_provinceId_cityId_districtId_villageId_idx`(`provinceId`, `cityId`, `districtId`, `villageId`),
    INDEX `DeliveryCoverage_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Order_coverageId_idx` ON `Order`(`coverageId`);

-- AddForeignKey
ALTER TABLE `DeliveryCoverage` ADD CONSTRAINT `DeliveryCoverage_provinceId_fkey` FOREIGN KEY (`provinceId`) REFERENCES `Province`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeliveryCoverage` ADD CONSTRAINT `DeliveryCoverage_cityId_fkey` FOREIGN KEY (`cityId`) REFERENCES `City`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeliveryCoverage` ADD CONSTRAINT `DeliveryCoverage_districtId_fkey` FOREIGN KEY (`districtId`) REFERENCES `District`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeliveryCoverage` ADD CONSTRAINT `DeliveryCoverage_villageId_fkey` FOREIGN KEY (`villageId`) REFERENCES `Village`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_coverageId_fkey` FOREIGN KEY (`coverageId`) REFERENCES `DeliveryCoverage`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

