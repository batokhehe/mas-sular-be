import { buildOutboxEvent } from '../../src/infrastructure/outbox/outbox-event.builder';

describe('buildOutboxEvent (H2 — single source of truth for the envelope)', () => {
  const input = {
    aggregateType: 'payment',
    aggregateId: 'pay-1',
    eventName: 'payment.paid',
    exchange: 'payments',
    routingKey: 'payment.paid',
    payload: { paymentId: 'pay-1', orderId: 'o-1' },
    metadata: { source: 'admin.verifyPayment' },
  };

  it('produces the exact legacy envelope shape (id, eventVersion 1, occurredAt default)', () => {
    const before = Date.now();
    const event = buildOutboxEvent(input);
    expect(event).toMatchObject({
      aggregateType: 'payment',
      aggregateId: 'pay-1',
      eventName: 'payment.paid',
      eventVersion: 1,
      exchange: 'payments',
      routingKey: 'payment.paid',
      payload: { paymentId: 'pay-1', orderId: 'o-1' },
      metadata: { source: 'admin.verifyPayment' },
    });
    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    // Exact key set — nothing extra rides into the Prisma create.
    expect(Object.keys(event).sort()).toEqual(
      ['aggregateId', 'aggregateType', 'eventName', 'eventVersion', 'exchange', 'id', 'metadata', 'occurredAt', 'payload', 'routingKey'].sort(),
    );
  });

  it('honors an explicit occurredAt (worker fake-time seams)', () => {
    const at = new Date('2026-07-10T00:00:00Z');
    expect(buildOutboxEvent({ ...input, occurredAt: at }).occurredAt).toBe(at);
  });

  it('generates a fresh id per call and omits metadata cleanly when not given', () => {
    const { metadata: _unused, ...noMeta } = input;
    const a = buildOutboxEvent(noMeta);
    const b = buildOutboxEvent(noMeta);
    expect(a.id).not.toBe(b.id);
    expect(a.metadata).toBeUndefined();
  });
});
