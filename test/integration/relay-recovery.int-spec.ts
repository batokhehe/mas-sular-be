/**
 * H. Relay crash recovery — simulate a publish that succeeded but whose process
 * restarted before markPublished (the row stays PENDING). The relay reclaims the row
 * and republishes (at-least-once), and the consumer's ProcessedEvent dedup ensures the
 * duplicate delivery produces no duplicate effect (exactly-once NotificationOutbox).
 */
import { checkout, getWorld, waitFor, type IntegrationWorld } from './world'

let world: IntegrationWorld

beforeAll(async () => {
  world = await getWorld()
}, 180_000)

describe('H. Relay crash recovery', () => {
  it('reclaims an unmarked row, republishes, and the consumer dedup prevents a duplicate effect', async () => {
    const { outboxId } = await checkout(world)
    const row = await world.prisma.outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })

    // Publish succeeded, but the process "restarted" before markPublished: the same
    // message (messageId = row.id) is on the broker while the row is still PENDING.
    const body = Buffer.from(JSON.stringify({ id: row.id, name: row.eventName, occurredAt: row.occurredAt, payload: row.payload }))
    await world.rabbit.publishWithConfirm(row.exchange, row.routingKey, body, {
      contentType: 'application/json',
      persistent: true,
      messageId: row.id,
      type: row.eventName,
    })
    await waitFor(async () => (await world.prisma.notificationOutbox.count({ where: { sourceMessageId: outboxId } })) === 1)

    // Relay reclaims the still-PENDING row and republishes it (second delivery).
    expect(await world.relay.processBatch()).toBeGreaterThanOrEqual(1)
    expect((await world.prisma.outboxEvent.findUnique({ where: { id: outboxId } }))?.status).toBe('PUBLISHED')

    // ProcessedEvent dedup (unique on messageId) → still exactly one effect.
    await new Promise((r) => setTimeout(r, 1000))
    expect(await world.prisma.notificationOutbox.count({ where: { sourceMessageId: outboxId } })).toBe(1)
    expect(await world.prisma.processedEvent.count({ where: { messageId: outboxId } })).toBe(1)
  })
})
