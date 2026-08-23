-- Physical attributes for courier booking (Paxel CREATE needs per-item
-- weight and dimensions). Additive only: every column is nullable except
-- Product.isFragile, which carries a default, so existing rows are untouched
-- and no backfill is performed. A product or order item without real
-- measurements must fail a shipment loudly rather than ship on invented data.

-- AlterTable
ALTER TABLE `Product` ADD COLUMN `heightCm` INTEGER NULL,
    ADD COLUMN `isFragile` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `lengthCm` INTEGER NULL,
    ADD COLUMN `weightGram` INTEGER NULL,
    ADD COLUMN `widthCm` INTEGER NULL;

-- AlterTable
-- Snapshotted from Product at order creation, alongside productName/unitPrice.
ALTER TABLE `OrderItem` ADD COLUMN `heightCm` INTEGER NULL,
    ADD COLUMN `isFragile` BOOLEAN NULL,
    ADD COLUMN `lengthCm` INTEGER NULL,
    ADD COLUMN `weightGram` INTEGER NULL,
    ADD COLUMN `widthCm` INTEGER NULL;
