-- Additive indexes for the Queue Center: newest-first outbox listing + event-name filter.
CREATE INDEX `OutboxEvent_createdAt_idx` ON `OutboxEvent`(`createdAt`);
CREATE INDEX `OutboxEvent_eventName_createdAt_idx` ON `OutboxEvent`(`eventName`, `createdAt`);
