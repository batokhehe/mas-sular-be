/**
 * E. Payment rejection flow E2E — admin reject moves the payment to FAILED, cancels
 * the order, restores the reserved inventory, and emits payment.failed exactly once.
 */
import { getWorld, seedScenario, type IntegrationWorld } from './world'

let world: IntegrationWorld

beforeAll(async () => {
  world = await getWorld()
}, 180_000)

describe('E. Payment rejection flow E2E', () => {
  it('reject → FAILED + order CANCELLED + inventory restored + payment.failed once', async () => {
    // stock 9 models "10 in stock − 1 reserved at checkout"; rejection must restore to 10.
    const s = await seedScenario(world, { method: 'BANK_TRANSFER', paymentStatus: 'WAITING_VERIFICATION', orderStatus: 'PROCESSING', stock: 9 })

    await world.admin.rejectPayment(s.payment.id, {})

    expect((await world.prisma.payment.findUnique({ where: { id: s.payment.id } }))?.status).toBe('FAILED')
    expect((await world.prisma.order.findUnique({ where: { id: s.order.id } }))?.status).toBe('CANCELLED')
    expect((await world.prisma.product.findUnique({ where: { id: s.productId } }))?.stock).toBe(10)

    expect(await world.prisma.outboxEvent.count({ where: { aggregateId: s.payment.id, eventName: 'payment.failed' } })).toBe(1)
  })
})
