-- PAXELBOX-61E: JNE's own destination/origin master data + reviewed district mapping.
--
-- Additive and reversible: two new tables and four new enums. Nothing existing is
-- altered, no column is dropped, no data is backfilled, and no existing row is
-- touched. `District` gains only a back-relation, which is a Prisma-level concept
-- and emits no SQL.
--
-- WHY A SEPARATE TABLE RATHER THAN A COLUMN ON A REGION MODEL
-- JNE's granularity is its own. The observed sandbox dataset is predominantly
-- DISTRICT-level (7,763 two-part names such as "CIBIRU,BANDUNG") with a CITY tier
-- (539 one-part names such as "BANDUNG"). It matches no single Kemendagri level,
-- so a column on Village or District would be wrong for the other. That is the
-- mistake District.rajaOngkirId already made once and 20260831000001 undid.
--
-- rawName is VarChar(255) and holds the API value VERBATIM, including the comma
-- spacing and edge whitespace present in 1,370 and 566 rows respectively. The
-- normalized/parsed columns are derived companions, never replacements.

CREATE TABLE `JneLocation` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `rawName` VARCHAR(255) NOT NULL,
    `normalizedName` VARCHAR(255) NOT NULL,
    `parsedChild` VARCHAR(255) NOT NULL,
    `parsedParent` VARCHAR(255) NULL,
    `partCount` INTEGER NOT NULL,
    `kind` ENUM('ORIGIN', 'DESTINATION') NOT NULL,
    `source` ENUM('SANDBOX', 'PRODUCTION') NOT NULL,
    `sourceFetchedAt` DATETIME(3) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `JneLocation_code_key`(`code`),
    INDEX `JneLocation_kind_parsedParent_parsedChild_idx`(`kind`, `parsedParent`, `parsedChild`),
    INDEX `JneLocation_normalizedName_idx`(`normalizedName`),
    INDEX `JneLocation_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Not unique on districtId alone, deliberately: 512 JNE names carry more than one
-- code and 498 span different routing hubs, so a district may later need a
-- per-origin code. Whether the origin hub selects the code is UNPROVEN and needs
-- tariff evidence, so no origin discriminator exists yet -- the composite key
-- simply leaves room for one without a further migration.
CREATE TABLE `JneDistrictMapping` (
    `id` VARCHAR(191) NOT NULL,
    `districtId` VARCHAR(191) NOT NULL,
    `jneLocationId` VARCHAR(191) NOT NULL,
    `status` ENUM('MATCHED', 'REVIEW_REQUIRED', 'AMBIGUOUS', 'NOT_FOUND') NOT NULL DEFAULT 'REVIEW_REQUIRED',
    `method` ENUM('EXACT_NAME', 'REVIEWED_ALIAS', 'MANUAL') NOT NULL,
    `confidence` VARCHAR(32) NULL,
    `evidence` JSON NULL,
    `notes` TEXT NULL,
    `reviewedBy` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `JneDistrictMapping_districtId_jneLocationId_key`(`districtId`, `jneLocationId`),
    INDEX `JneDistrictMapping_status_idx`(`status`),
    INDEX `JneDistrictMapping_districtId_idx`(`districtId`),
    INDEX `JneDistrictMapping_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `JneDistrictMapping` ADD CONSTRAINT `JneDistrictMapping_districtId_fkey`
    FOREIGN KEY (`districtId`) REFERENCES `District`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: deleting a JNE master row must never silently delete a
-- reviewed mapping. A refresh deactivates rows (isActive) instead of removing them.
ALTER TABLE `JneDistrictMapping` ADD CONSTRAINT `JneDistrictMapping_jneLocationId_fkey`
    FOREIGN KEY (`jneLocationId`) REFERENCES `JneLocation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
