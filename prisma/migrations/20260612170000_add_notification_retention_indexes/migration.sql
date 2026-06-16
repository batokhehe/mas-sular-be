-- CreateIndex
CREATE INDEX `NotificationOutbox_status_sentAt_idx` ON `NotificationOutbox`(`status`, `sentAt`);

-- CreateIndex
CREATE INDEX `NotificationOutbox_status_createdAt_idx` ON `NotificationOutbox`(`status`, `createdAt`);
