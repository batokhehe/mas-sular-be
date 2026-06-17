/**
 * G. Expiry flow E2E — a payment older than the expiry window is moved to EXPIRED,
 * its order is cancelled, inventory restored, and payment.expired emitted exactly once.
 * A second worker pass does not duplicate the expiry.
 */
import { getWorld, seedScenario, HOUR, type IntegrationWorld } from './world'

let world: IntegrationWorld

beforeAll(async () => {
  world = await getWorld()
}, 180_000)

describe('G. Expiry flow E2E', () => {
  it('expires the payment, cancels the order, restores stock, emits payment.expired once', async () => {
    // 25h old: past the 24h BANK_TRANSFER expiry window. stock 9 → restored to 10.
    const paymentCreatedAt = new Date(Date.now() - 25 * HOUR)
    const s = await seedScenario(world, { method: 'BANK_TRANSFER', paymentStatus: 'PENDING', orderStatus: 'PENDING', stock: 9, paymentCreatedAt })

    expect(await world.lifecycle.runExpiry()).toBeGreaterThanOrEqual(1)

    expect((await world.prisma.payment.findUnique({ where: { id: s.payment.id } }))?.status).toBe('EXPIRED')
    expect((await world.prisma.order.findUnique({ where: { id: s.order.id } }))?.status).toBe('CANCELLED')
    expect((await world.prisma.product.findUnique({ where: { id: s.productId } }))?.stock).toBe(10)
    expect(await world.prisma.outboxEvent.count({ where: { aggregateId: s.payment.id, eventName: 'payment.expired' } })).toBe(1)

    // Re-run: payment already EXPIRED (terminal) → CAS no-ops, no duplicate event.
    await world.lifecycle.runExpiry()
    expect(await world.prisma.outboxEvent.count({ where: { aggregateId: s.payment.id, eventName: 'payment.expired' } })).toBe(1)
  })
})
