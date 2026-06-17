/**
 * C. Payment upload flow E2E — mint a single-use token, submit a receipt via the
 * tokenized (unauthenticated) path, and assert the payment moves to
 * WAITING_VERIFICATION with payment.receipt_uploaded emitted exactly once.
 */
import { getWorld, seedScenario, type IntegrationWorld } from './world'

let world: IntegrationWorld

beforeAll(async () => {
  world = await getWorld()
}, 180_000)

describe('C. Payment upload flow E2E', () => {
  it('token → submit receipt moves the payment to WAITING_VERIFICATION and emits the event once', async () => {
    const s = await seedScenario(world, { method: 'BANK_TRANSFER', paymentStatus: 'PENDING', orderStatus: 'PENDING' })

    // 1. Create upload token (raw secret returned only here).
    const { rawToken } = await world.prisma.$transaction((tx) => world.uploadTokens.issue(tx, s.payment.id))

    // 2 + 3. Upload + submit receipt via the single-use token.
    await world.payments.submitReceiptByToken(rawToken, {
      receiptUrl: 'https://example.test/receipt.png',
      bankName: 'BCA',
      accountName: 'Jane',
    })

    const payment = await world.prisma.payment.findUnique({ where: { id: s.payment.id } })
    expect(payment?.status).toBe('WAITING_VERIFICATION')

    const events = await world.prisma.outboxEvent.findMany({
      where: { aggregateId: s.payment.id, eventName: 'payment.receipt_uploaded' },
    })
    expect(events).toHaveLength(1)

    // The token is single-use: a replay must not emit a second event.
    await expect(
      world.payments.submitReceiptByToken(rawToken, { receiptUrl: 'https://example.test/receipt.png', bankName: 'BCA', accountName: 'Jane' }),
    ).rejects.toThrow()
    const after = await world.prisma.outboxEvent.count({ where: { aggregateId: s.payment.id, eventName: 'payment.receipt_uploaded' } })
    expect(after).toBe(1)
  })
})
