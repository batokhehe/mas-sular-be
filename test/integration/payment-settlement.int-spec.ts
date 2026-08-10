/**
 * Phase 5D — gateway settlement against REAL MySQL.
 *
 * The unit suite proves the orchestration and the rollback ordering against doubles.
 * These specs prove what a double cannot: that the transaction, the CAS and the
 * FOR UPDATE guard actually hold in the database — one business transition under
 * concurrency, and no partial state after a failure.
 */
import { randomUUID } from 'node:crypto'
import { GatewayTransactionStatus } from '@prisma/client'
import { PaymentSettlementService } from '../../src/modules/payments/settlement/payment-settlement.service'
import { getWorld, seedScenario, type IntegrationWorld } from './world'

let world: IntegrationWorld
let settlement: PaymentSettlementService

beforeAll(async () => {
  world = await getWorld()
  // No shipment/inventory collaborators: this suite isolates the state transition
  // and the outbox. Inventory commit has its own coverage in the checkout suite.
  settlement = new PaymentSettlementService(world.prisma)
}, 180_000)

async function attempt(opts: { paymentStatus?: 'PENDING' | 'EXPIRED' | 'PAID'; orderStatus?: 'PENDING' | 'PROCESSING' } = {}) {
  const s = await seedScenario(world, {
    method: 'QRIS',
    paymentStatus: opts.paymentStatus ?? 'PENDING',
    orderStatus: opts.orderStatus ?? 'PENDING',
  })
  const providerOrderId = `${s.order.orderNumber}-${randomUUID().slice(0, 8)}`
  const gtx = await world.prisma.paymentGatewayTransaction.create({
    data: {
      paymentId: s.payment.id, provider: 'midtrans', channelCode: 'QRIS',
      providerOrderId, grossAmount: 40000, status: 'PENDING',
    },
  })
  return { scenario: s, gtx, providerOrderId }
}

const actor = (gatewayTransactionId: string) => ({
  kind: 'GATEWAY' as const,
  provider: 'midtrans',
  providerStatus: 'settlement',
  providerTransactionId: `trx-${randomUUID().slice(0, 8)}`,
  gatewayTransactionId,
  gatewayStatus: GatewayTransactionStatus.SETTLEMENT,
})

describe('Phase 5D. Gateway settlement (real MySQL)', () => {
  it('settles payment + order + gateway + outbox atomically', async () => {
    const { scenario, gtx } = await attempt()
    const out = await settlement.settle(scenario.payment.id, actor(gtx.id))
    expect(out.result).toBe('SETTLED')

    expect((await world.prisma.payment.findUnique({ where: { id: scenario.payment.id } }))!.status).toBe('PAID')
    expect((await world.prisma.order.findUnique({ where: { id: scenario.order.id } }))!.status).toBe('PROCESSING')

    const row = await world.prisma.paymentGatewayTransaction.findUnique({ where: { id: gtx.id } })
    expect(row!.status).toBe('SETTLEMENT')
    expect(row!.providerStatus).toBe('settlement')

    // Exactly one payment.paid, built by the shared envelope builder.
    const events = await world.prisma.outboxEvent.findMany({
      where: { aggregateId: scenario.payment.id, eventName: 'payment.paid' },
    })
    expect(events).toHaveLength(1)
    expect((events[0].metadata as Record<string, unknown>).source).toBe('payments.webhook.midtrans')
  })

  it('a second settlement is an idempotent no-op — no duplicate event', async () => {
    const { scenario, gtx } = await attempt()
    await settlement.settle(scenario.payment.id, actor(gtx.id))
    const repeat = await settlement.settle(scenario.payment.id, actor(gtx.id))

    expect(repeat.result).toBe('ALREADY_PAID')
    expect(await world.prisma.outboxEvent.count({
      where: { aggregateId: scenario.payment.id, eventName: 'payment.paid' },
    })).toBe(1)
  })

  it('CONCURRENT settlements produce exactly ONE business transition', async () => {
    const { scenario, gtx } = await attempt()

    const results = await Promise.all(
      Array.from({ length: 5 }, () => settlement.settle(scenario.payment.id, actor(gtx.id)).catch((e: Error) => e)),
    )
    const settled = results.filter((r) => !(r instanceof Error) && r.result === 'SETTLED')

    expect(settled).toHaveLength(1) // the CAS admits one winner
    expect(await world.prisma.outboxEvent.count({
      where: { aggregateId: scenario.payment.id, eventName: 'payment.paid' },
    })).toBe(1) // exactly-once event emission
  })

  it('refuses to resurrect an EXPIRED payment', async () => {
    const { scenario, gtx } = await attempt({ paymentStatus: 'EXPIRED' })
    await expect(settlement.settle(scenario.payment.id, actor(gtx.id))).rejects.toThrow(/terminal status EXPIRED/)

    expect((await world.prisma.payment.findUnique({ where: { id: scenario.payment.id } }))!.status).toBe('EXPIRED')
    expect(await world.prisma.outboxEvent.count({
      where: { aggregateId: scenario.payment.id, eventName: 'payment.paid' },
    })).toBe(0)
  })

  it('refuses to resurrect a CANCELLED order — and rolls the payment flip back', async () => {
    const { scenario, gtx } = await attempt()
    await world.prisma.order.update({ where: { id: scenario.order.id }, data: { status: 'CANCELLED' } })

    await expect(settlement.settle(scenario.payment.id, actor(gtx.id))).rejects.toThrow(/cancelled/i)

    // The payment flip happened FIRST inside the transaction; it must be gone.
    expect((await world.prisma.payment.findUnique({ where: { id: scenario.payment.id } }))!.status).toBe('PENDING')
    expect((await world.prisma.order.findUnique({ where: { id: scenario.order.id } }))!.status).toBe('CANCELLED')
    expect(await world.prisma.outboxEvent.count({
      where: { aggregateId: scenario.payment.id, eventName: 'payment.paid' },
    })).toBe(0)
    expect((await world.prisma.paymentGatewayTransaction.findUnique({ where: { id: gtx.id } }))!.providerStatus).toBeNull()
  })

  it('settlement racing an order cancellation leaves no partial state', async () => {
    const { scenario, gtx } = await attempt()

    const [settleResult] = await Promise.all([
      settlement.settle(scenario.payment.id, actor(gtx.id)).catch((e: Error) => e),
      world.prisma.order.update({ where: { id: scenario.order.id }, data: { status: 'CANCELLED' } }).catch(() => null),
    ])

    const payment = await world.prisma.payment.findUnique({ where: { id: scenario.payment.id } })
    const order = await world.prisma.order.findUnique({ where: { id: scenario.order.id } })
    const events = await world.prisma.outboxEvent.count({
      where: { aggregateId: scenario.payment.id, eventName: 'payment.paid' },
    })

    // Whichever won, the pair is consistent: PAID+PROCESSING with one event, or
    // PENDING+CANCELLED with none. Never PAID against a CANCELLED order.
    if (!(settleResult instanceof Error) && settleResult.result === 'SETTLED') {
      expect(payment!.status).toBe('PAID')
      expect(order!.status).not.toBe('CANCELLED')
      expect(events).toBe(1)
    } else {
      expect(payment!.status).toBe('PENDING')
      expect(events).toBe(0)
    }
  })

  it('admin verification and gateway settlement emit an identical event shape', async () => {
    const gateway = await attempt()
    await settlement.settle(gateway.scenario.payment.id, actor(gateway.gtx.id))
    const gatewayEvent = await world.prisma.outboxEvent.findFirst({
      where: { aggregateId: gateway.scenario.payment.id, eventName: 'payment.paid' },
    })

    const admin = await seedScenario(world, { paymentStatus: 'WAITING_VERIFICATION', orderStatus: 'PENDING' })
    await world.admin.verifyPayment(admin.payment.id, randomUUID(), {})
    const adminEvent = await world.prisma.outboxEvent.findFirst({
      where: { aggregateId: admin.payment.id, eventName: 'payment.paid' },
    })

    expect(gatewayEvent!.routingKey).toBe(adminEvent!.routingKey)
    expect(gatewayEvent!.exchange).toBe(adminEvent!.exchange)
    expect(Object.keys(gatewayEvent!.payload as object).sort())
      .toEqual(Object.keys(adminEvent!.payload as object).sort())
  })
})
