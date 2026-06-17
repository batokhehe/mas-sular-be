/**
 * I. Consumer redelivery — RabbitMQ redelivers the same message (same messageId).
 * The consumer's ProcessedEvent dedup ensures the redelivery produces no duplicate
 * NotificationOutbox row (exactly-once effect under at-least-once delivery).
 */
import { checkout, getWorld, waitFor, type IntegrationWorld } from './world'

let world: IntegrationWorld

beforeAll(async () => {
  world = await getWorld()
}, 180_000)

describe('I. Consumer redelivery', () => {
  it('dedups a redelivered message so no duplicate NotificationOutbox is created', async () => {
    const { outboxId } = await checkout(world)
    const row = await world.prisma.outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })
    const body = Buffer.from(JSON.stringify({ id: row.id, name: row.eventName, occurredAt: row.occurredAt, payload: row.payload }))
    const options = { contentType: 'application/json', persistent: true, messageId: row.id, type: row.eventName }

    // First delivery → one effect.
    await world.rabbit.publishWithConfirm(row.exchange, row.routingKey, body, options)
    await waitFor(async () => (await world.prisma.notificationOutbox.count({ where: { sourceMessageId: outboxId } })) === 1)
    expect(await world.prisma.processedEvent.count({ where: { messageId: outboxId } })).toBe(1)

    // Broker redelivers the SAME message → consumer dedups on ProcessedEvent.
    await world.rabbit.publishWithConfirm(row.exchange, row.routingKey, body, options)
    await new Promise((r) => setTimeout(r, 1000))

    expect(await world.prisma.notificationOutbox.count({ where: { sourceMessageId: outboxId } })).toBe(1)
    expect(await world.prisma.processedEvent.count({ where: { messageId: outboxId } })).toBe(1)
  })
})
