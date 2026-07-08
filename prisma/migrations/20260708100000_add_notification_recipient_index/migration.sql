-- Customer Communication Center: conversation lookups by recipient.
CREATE INDEX `NotificationOutbox_recipient_createdAt_idx` ON `NotificationOutbox`(`recipient`, `createdAt`);
