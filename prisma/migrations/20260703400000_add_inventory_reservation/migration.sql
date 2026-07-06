-- CreateTable
CREATE TABLE `InventoryReservation` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `productVariantId` VARCHAR(191) NULL,
    `outletId` VARCHAR(191) NULL,
    `reservedQty` INTEGER NOT NULL,
    `committedQty` INTEGER NOT NULL DEFAULT 0,
    `releasedQty` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'RESERVED',
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `InventoryReservation_status_expiresAt_idx`(`status`, `expiresAt`),
    INDEX `InventoryReservation_orderId_idx`(`orderId`),
    INDEX `InventoryReservation_productId_status_idx`(`productId`, `status`),
    INDEX `InventoryReservation_outletId_idx`(`outletId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InventoryReservationHistory` (
    `id` VARCHAR(191) NOT NULL,
    `reservationId` VARCHAR(191) NOT NULL,
    `status` ENUM('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED', 'CANCELLED') NOT NULL,
    `note` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `InventoryReservationHistory_reservationId_createdAt_idx`(`reservationId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `InventoryReservation` ADD CONSTRAINT `InventoryReservation_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InventoryReservation` ADD CONSTRAINT `InventoryReservation_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InventoryReservation` ADD CONSTRAINT `InventoryReservation_outletId_fkey` FOREIGN KEY (`outletId`) REFERENCES `Outlet`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InventoryReservationHistory` ADD CONSTRAINT `InventoryReservationHistory_reservationId_fkey` FOREIGN KEY (`reservationId`) REFERENCES `InventoryReservation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

