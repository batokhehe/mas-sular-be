/**
 * D. Payment verification flow E2E — admin verify moves the payment to PAID and the
 * order to PROCESSING, emits payment.paid exactly once, and the consumer queues one
 * notification. A repeat verify is an idempotent no-op (no duplicate event/notification).
 */
import { randomUUID } from 'node:crypto'
import { getWorld, seedScenario, waitFor, type IntegrationWorld } from './world'

let world: IntegrationWorld

beforeAll(async () => {
  world = await getWorld()
}, 180_000)

describe('D. Payment verification flow E2E', () => {
  it('verify → PAID + order PROCESSING + payment.paid once + one notification; replay is a no-op', async () => {
    const s = await seedScenario(world, { method: 'BANK_TRANSFER', paymentStatus: 'WAITING_VERIFICATION', orderStatus: 'PENDING' })
    const adminId = randomUUID()

    await world.admin.verifyPayment(s.payment.id, adminId, {})

    expect((await world.prisma.payment.findUnique({ where: { id: s.payment.id } }))?.status).toBe('PAID')
    expect((await world.prisma.order.findUnique({ where: { id: s.order.id } }))?.status).toBe('PROCESSING')

    const evt = await world.prisma.outboxEvent.findFirst({ where: { aggregateId: s.payment.id, eventName: 'payment.paid' } })
    expect(evt).not.toBeNull()
    expect(await world.prisma.outboxEvent.count({ where: { aggregateId: s.payment.id, eventName: 'payment.paid' } })).toBe(1)

    await world.relay.processBatch()
    await waitFor(async () => (await world.prisma.notificationOutbox.count({ where: { sourceMessageId: evt!.id } })) === 1)

    // Repeat verify: already PAID → returns current with no side effects.
    await world.admin.verifyPayment(s.payment.id, adminId, {})
    await world.relay.processBatch()
    await new Promise((r) => setTimeout(r, 500))

    expect(await world.prisma.outboxEvent.count({ where: { aggregateId: s.payment.id, eventName: 'payment.paid' } })).toBe(1)
    expect(await world.prisma.notificationOutbox.count({ where: { sourceMessageId: evt!.id } })).toBe(1)
  })
})
