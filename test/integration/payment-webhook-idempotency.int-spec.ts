/**
 * Phase 5C — webhook idempotency against REAL MySQL.
 *
 * The unit suite proves the algorithm against a Prisma double. These specs prove the
 * part a double cannot: that the DATABASE enforces the invariant. Concurrent
 * duplicate deliveries collide on the `PaymentWebhookEvent.fingerprint` unique index
 * — there is no application mutex anywhere in the path.
 */
import { randomUUID } from 'node:crypto'
import { PaymentGatewayPersistenceService } from '../../src/modules/payments/gateway/payment-gateway-persistence.service'
import { getWorld, seedScenario, type IntegrationWorld } from './world'

let world: IntegrationWorld
let ledger: PaymentGatewayPersistenceService

beforeAll(async () => {
  world = await getWorld()
  ledger = new PaymentGatewayPersistenceService(world.prisma)
}, 180_000)

/** A charge attempt whose providerOrderId is the id we actually sent Midtrans. */
async function attempt(providerOrderId: string) {
  const s = await seedScenario(world, { method: 'QRIS', paymentStatus: 'PENDING', orderStatus: 'PENDING' })
  const gtx = await world.prisma.paymentGatewayTransaction.create({
    data: {
      paymentId: s.payment.id,
      provider: 'midtrans',
      channelCode: 'QRIS',
      providerOrderId,
      grossAmount: 40000,
      status: 'PENDING',
    },
  })
  return { scenario: s, gtx }
}

const notification = (providerOrderId: string, gatewayTransactionId: string, over: Record<string, unknown> = {}) => ({
  provider: 'midtrans',
  fingerprint: 'a'.repeat(64),
  gatewayTransactionId,
  providerOrderId,
  providerStatus: 'settlement',
  transactionStatus: 'settlement',
  statusCode: '200',
  grossAmount: '40000.00',
  notifiedAt: new Date('2026-08-08T10:05:00Z'),
  payload: { order_id: providerOrderId, transaction_status: 'settlement' },
  ...over,
})

describe('Phase 5C. Webhook idempotency (real MySQL)', () => {
  it('first delivery records one event and refreshes the ledger snapshot', async () => {
    const orderId = `BMS-${randomUUID().slice(0, 8)}-aaaaaaaa`
    const { gtx, scenario } = await attempt(orderId)
    const fingerprint = randomUUID().replace(/-/g, '').padEnd(64, '0')

    const outcome = await ledger.recordWebhookNotification(notification(orderId, gtx.id, { fingerprint }))
    expect(outcome).toBe('applied')

    const row = await world.prisma.paymentGatewayTransaction.findUnique({ where: { id: gtx.id } })
    expect(row!.providerStatus).toBe('settlement') // verbatim, unmapped
    expect(row!.providerStatusAt).toEqual(new Date('2026-08-08T10:05:00Z'))
    expect(row!.status).toBe('PENDING') // gateway enum NOT moved — that is 5D

    // Business state is untouched.
    expect((await world.prisma.payment.findUnique({ where: { id: scenario.payment.id } }))!.status).toBe('PENDING')
    expect((await world.prisma.order.findUnique({ where: { id: scenario.order.id } }))!.status).toBe('PENDING')
    expect(await world.prisma.outboxEvent.count({ where: { aggregateId: scenario.payment.id } })).toBe(0)
    expect(await world.prisma.paymentWebhookEvent.count({ where: { fingerprint } })).toBe(1)
  })

  it('100 sequential redeliveries → one event, one ledger mutation', async () => {
    const orderId = `BMS-${randomUUID().slice(0, 8)}-bbbbbbbb`
    const { gtx } = await attempt(orderId)
    const fingerprint = randomUUID().replace(/-/g, '').padEnd(64, '1')

    const outcomes: string[] = []
    for (let i = 0; i < 100; i++) {
      outcomes.push(await ledger.recordWebhookNotification(notification(orderId, gtx.id, { fingerprint })))
    }

    expect(outcomes[0]).toBe('applied')
    expect(outcomes.slice(1).every((o) => o === 'duplicate')).toBe(true)
    expect(await world.prisma.paymentWebhookEvent.count({ where: { fingerprint } })).toBe(1)
  })

  it('CONCURRENT duplicate deliveries: the unique index admits exactly one', async () => {
    const orderId = `BMS-${randomUUID().slice(0, 8)}-cccccccc`
    const { gtx, scenario } = await attempt(orderId)
    const fingerprint = randomUUID().replace(/-/g, '').padEnd(64, '2')

    // Ten real connections racing the same notification. No mutex, no advisory lock.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ledger.recordWebhookNotification(notification(orderId, gtx.id, { fingerprint }))),
    )

    expect(results.filter((r) => r === 'applied')).toHaveLength(1)
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(9)
    expect(await world.prisma.paymentWebhookEvent.count({ where: { fingerprint } })).toBe(1)
    expect((await world.prisma.payment.findUnique({ where: { id: scenario.payment.id } }))!.status).toBe('PENDING')
  })

  it('a failed transaction releases the key — the redelivery still processes', async () => {
    const orderId = `BMS-${randomUUID().slice(0, 8)}-dddddddd`
    const { gtx } = await attempt(orderId)
    const fingerprint = randomUUID().replace(/-/g, '').padEnd(64, '3')

    // Force the ledger update inside the transaction to fail: a gateway transaction
    // id that does not exist makes updateMany match nothing, so instead we break the
    // write with an over-long value the column cannot hold.
    await expect(
      ledger.recordWebhookNotification(notification(orderId, gtx.id, { fingerprint, providerStatus: 'x'.repeat(64) })),
    ).rejects.toBeDefined()

    // Rolled back: the fingerprint was NOT consumed.
    expect(await world.prisma.paymentWebhookEvent.count({ where: { fingerprint } })).toBe(0)

    const retry = await ledger.recordWebhookNotification(notification(orderId, gtx.id, { fingerprint }))
    expect(retry).toBe('applied')
    expect(await world.prisma.paymentWebhookEvent.count({ where: { fingerprint } })).toBe(1)
  })

  it('a strictly older notification cannot overwrite newer gateway information', async () => {
    const orderId = `BMS-${randomUUID().slice(0, 8)}-eeeeeeee`
    const { gtx } = await attempt(orderId)

    await ledger.recordWebhookNotification(
      notification(orderId, gtx.id, {
        fingerprint: randomUUID().replace(/-/g, '').padEnd(64, '4'),
        providerStatus: 'settlement',
        notifiedAt: new Date('2026-08-08T10:05:00Z'),
      }),
    )

    // A `pending` delivered late, stamped earlier.
    const stale = await ledger.recordWebhookNotification(
      notification(orderId, gtx.id, {
        fingerprint: randomUUID().replace(/-/g, '').padEnd(64, '5'),
        providerStatus: 'pending',
        notifiedAt: new Date('2026-08-08T10:00:00Z'),
      }),
    )

    expect(stale).toBe('stale')
    const row = await world.prisma.paymentGatewayTransaction.findUnique({ where: { id: gtx.id } })
    expect(row!.providerStatus).toBe('settlement') // newer value survived
    // …and the older notification is still recorded, so nothing is ever lost.
    expect(await world.prisma.paymentWebhookEvent.count({ where: { providerOrderId: orderId } })).toBe(2)
  })

  it('genuinely different notifications for one order are all recorded', async () => {
    const orderId = `BMS-${randomUUID().slice(0, 8)}-ffffffff`
    const { gtx } = await attempt(orderId)

    await ledger.recordWebhookNotification(
      notification(orderId, gtx.id, {
        fingerprint: randomUUID().replace(/-/g, '').padEnd(64, '6'),
        providerStatus: 'pending', statusCode: '201', notifiedAt: new Date('2026-08-08T10:00:00Z'),
      }),
    )
    await ledger.recordWebhookNotification(
      notification(orderId, gtx.id, {
        fingerprint: randomUUID().replace(/-/g, '').padEnd(64, '7'),
        providerStatus: 'settlement', notifiedAt: new Date('2026-08-08T10:05:00Z'),
      }),
    )

    expect(await world.prisma.paymentWebhookEvent.count({ where: { providerOrderId: orderId } })).toBe(2)
    const row = await world.prisma.paymentGatewayTransaction.findUnique({ where: { id: gtx.id } })
    expect(row!.providerStatus).toBe('settlement')
  })

  it('the stored snapshot never contains a signature or a key', async () => {
    const orderId = `BMS-${randomUUID().slice(0, 8)}-99999999`
    const { gtx } = await attempt(orderId)
    const fingerprint = randomUUID().replace(/-/g, '').padEnd(64, '8')

    await ledger.recordWebhookNotification(notification(orderId, gtx.id, { fingerprint }))
    const event = await world.prisma.paymentWebhookEvent.findUnique({ where: { fingerprint } })

    expect(JSON.stringify(event!.payload)).not.toContain('signature')
    expect(JSON.stringify(event!.payload)).not.toContain('Mid-server')
  })
})
