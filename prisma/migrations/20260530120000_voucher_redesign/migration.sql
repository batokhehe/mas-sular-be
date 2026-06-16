-- Alter Promo columns to support new voucher fields
ALTER TABLE `Promo`
  CHANGE `discountPct` `discountPercentage` INTEGER UNSIGNED NULL,
  CHANGE `minSubtotal` `minimumOrderAmount` INTEGER NOT NULL DEFAULT 0,
  CHANGE `startsAt` `startDate` DATETIME(3) NULL,
  CHANGE `endsAt` `endDate` DATETIME(3) NULL,
  ADD COLUMN `voucherType` ENUM('FREE_SHIPPING', 'PERCENTAGE_DISCOUNT', 'FIXED_DISCOUNT') NOT NULL DEFAULT 'PERCENTAGE_DISCOUNT',
  ADD COLUMN `maxDiscountAmount` INTEGER UNSIGNED NULL,
  ADD COLUMN `freeShippingMaxAmount` INTEGER UNSIGNED NULL,
  ADD COLUMN `maxUsageCount` INTEGER UNSIGNED NULL,
  ADD COLUMN `currentUsageCount` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `isNewUserOnly` BOOLEAN NOT NULL DEFAULT false;

-- Add voucher metadata to Order
ALTER TABLE `Order`
  ADD COLUMN `voucherId` VARCHAR(191) NULL,
  ADD COLUMN `voucherCode` VARCHAR(191) NULL,
  ADD COLUMN `voucherType` ENUM('FREE_SHIPPING', 'PERCENTAGE_DISCOUNT', 'FIXED_DISCOUNT') NULL,
  ADD COLUMN `voucherDiscountAmount` INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT `Order_voucherId_fkey` FOREIGN KEY (`voucherId`) REFERENCES `Promo`(`id`) ON DELETE SET NULL;

-- Create VoucherUsage history table
CREATE TABLE `VoucherUsage` (
    `id` VARCHAR(191) NOT NULL,
    `voucherId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `VoucherUsage_voucherId_userId_key`(`voucherId`, `userId`),
    INDEX `VoucherUsage_userId_voucherId_idx`(`userId`, `voucherId`),
    INDEX `VoucherUsage_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `VoucherUsage_voucherId_fkey` FOREIGN KEY (`voucherId`) REFERENCES `Promo`(`id`) ON DELETE CASCADE,
    CONSTRAINT `VoucherUsage_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE,
    CONSTRAINT `VoucherUsage_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
