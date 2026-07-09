-- CreateTable (additive): admin-facing notifications, fan-out per admin.
CREATE TABLE `Notification` (
    `id` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(64) NOT NULL,
    `category` VARCHAR(32) NOT NULL,
    `priority` VARCHAR(16) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `message` TEXT NOT NULL,
    `url` VARCHAR(512) NULL,
    `icon` VARCHAR(64) NULL,
    `image` VARCHAR(512) NULL,
    `metadata` JSON NULL,
    `adminId` VARCHAR(36) NULL,
    `role` VARCHAR(64) NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT false,
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Notification_createdAt_idx`(`createdAt`),
    INDEX `Notification_isRead_createdAt_idx`(`isRead`, `createdAt`),
    INDEX `Notification_category_createdAt_idx`(`category`, `createdAt`),
    INDEX `Notification_adminId_createdAt_idx`(`adminId`, `createdAt`),
    INDEX `Notification_eventType_idx`(`eventType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable (additive): admin web-push (FCM) tokens.
CREATE TABLE `PushSubscription` (
    `id` VARCHAR(191) NOT NULL,
    `adminId` VARCHAR(36) NOT NULL,
    `token` VARCHAR(512) NOT NULL,
    `browser` VARCHAR(64) NULL,
    `platform` VARCHAR(64) NULL,
    `device` VARCHAR(64) NULL,
    `userAgent` VARCHAR(512) NULL,
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PushSubscription_adminId_token_key`(`adminId`, `token`(191)),
    INDEX `PushSubscription_adminId_idx`(`adminId`),
    INDEX `PushSubscription_lastSeenAt_idx`(`lastSeenAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
