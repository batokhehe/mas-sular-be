/**
 * F. Reminder flow E2E — a payment older than the first reminder window gets one
 * payment.reminder event + one notification; a second worker pass does not duplicate it.
 */
import { getWorld, seedScenario, waitFor, HOUR, type IntegrationWorld } from './world'

let world: IntegrationWorld

beforeAll(async () => {
  world = await getWorld()
}, 180_000)

describe('F. Reminder flow E2E', () => {
  it('emits payment.reminder once + a notification; re-running the worker does not duplicate', async () => {
    // 13h old: past the 12h first window, before the 20h second window.
    const paymentCreatedAt = new Date(Date.now() - 13 * HOUR)
    const s = await seedScenario(world, { method: 'BANK_TRANSFER', paymentStatus: 'PENDING', orderStatus: 'PENDING', paymentCreatedAt })

    expect(await world.lifecycle.runReminders()).toBeGreaterThanOrEqual(1)

    const evt = await world.prisma.outboxEvent.findFirst({ where: { aggregateId: s.payment.id, eventName: 'payment.reminder' } })
    expect(evt).not.toBeNull()
    expect(await world.prisma.outboxEvent.count({ where: { aggregateId: s.payment.id, eventName: 'payment.reminder' } })).toBe(1)

    await world.relay.processBatch()
    await waitFor(async () => (await world.prisma.notificationOutbox.count({ where: { sourceMessageId: evt!.id } })) === 1)

    // Re-run: firstReminderAt is now set and 20h has not elapsed → no second reminder.
    await world.lifecycle.runReminders()
    expect(await world.prisma.outboxEvent.count({ where: { aggregateId: s.payment.id, eventName: 'payment.reminder' } })).toBe(1)
  })
})
