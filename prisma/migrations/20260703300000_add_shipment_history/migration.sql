-- AlterTable
ALTER TABLE `Shipment` MODIFY `status` ENUM('PENDING', 'RATE_SELECTED', 'CREATED', 'WAITING_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'CANCELLED', 'UNKNOWN') NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE `ShipmentHistory` (
    `id` VARCHAR(191) NOT NULL,
    `shipmentId` VARCHAR(191) NOT NULL,
    `providerStatus` VARCHAR(191) NOT NULL,
    `mappedStatus` ENUM('PENDING', 'RATE_SELECTED', 'CREATED', 'WAITING_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'CANCELLED', 'UNKNOWN') NOT NULL,
    `changedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ShipmentHistory_shipmentId_changedAt_idx`(`shipmentId`, `changedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ShipmentHistory` ADD CONSTRAINT `ShipmentHistory_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `Shipment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

