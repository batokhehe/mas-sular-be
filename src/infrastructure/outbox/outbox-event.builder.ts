import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';

/**
 * Single source of truth for the OutboxEvent envelope (architecture audit H2).
 * PURE — no I/O, no Prisma; callers persist the result themselves, inside their
 * own transaction, as the LAST statement (the established outbox pattern):
 *
 *   await tx.outboxEvent.create({ data: buildOutboxEvent({ ... }) });
 *
 * Envelope invariants live here and ONLY here: a fresh UUID id, eventVersion 1,
 * and occurredAt defaulting to now (workers with fake-time seams pass their own).
 */
export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventName: string;
  exchange: string;
  routingKey: string;
  payload: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
  occurredAt?: Date;
}

export function buildOutboxEvent(input: OutboxEventInput) {
  return {
    id: randomUUID(),
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventName: input.eventName,
    eventVersion: 1,
    exchange: input.exchange,
    routingKey: input.routingKey,
    payload: input.payload,
    metadata: input.metadata,
    occurredAt: input.occurredAt ?? new Date(),
  };
}
