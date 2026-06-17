/**
 * B. Checkout flow E2E — order/payment/outbox persisted (real MySQL tx) → relay
 * publishes to RabbitMQ → consumer enqueues a NotificationOutbox row.
 */
import { checkout, getWorld, waitFor, type IntegrationWorld } from './world'

let world: IntegrationWorld

beforeAll(async () => {
  world = await getWorld()
}, 180_000)

describe('B. Checkout flow E2E', () => {
  it('persists order + payment + outbox, relays the event, and the consumer enqueues a notification', async () => {
    const { scenario, outboxId } = await checkout(world)

    // 1. Order persisted, 2. Payment persisted, 3. OutboxEvent created (PENDING).
    expect(await world.prisma.order.findUnique({ where: { id: scenario.order.id } })).not.toBeNull()
    expect(await world.prisma.payment.findUnique({ where: { orderId: scenario.order.id } })).not.toBeNull()
    const pending = await world.prisma.outboxEvent.findUnique({ where: { id: outboxId } })
    expect(pending?.status).toBe('PENDING')

    // Run the relay → 4. Event published to RabbitMQ (row marked PUBLISHED after the broker confirm).
    await world.relay.processBatch()
    const published = await world.prisma.outboxEvent.findUnique({ where: { id: outboxId } })
    expect(published?.status).toBe('PUBLISHED')

    // The running consumer drains the message → 5. NotificationOutbox created (exactly one).
    await waitFor(async () => (await world.prisma.notificationOutbox.count({ where: { sourceMessageId: outboxId } })) === 1)
    const notif = await world.prisma.notificationOutbox.findFirst({ where: { sourceMessageId: outboxId } })
    expect(notif?.template).toBe('order.received')
    expect(notif?.recipient).toBe(scenario.email)
  })
})
