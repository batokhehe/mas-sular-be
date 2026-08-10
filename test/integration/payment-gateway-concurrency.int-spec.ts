/**
 * Phase 5G — the payment gateway against REAL MySQL under REAL concurrency.
 *
 * Everything here runs the production services against the Testcontainers database:
 * real transactions, real CAS, real FOR UPDATE, real unique indexes. Only two things
 * are doubled, and only because they leave the process: the Midtrans HTTP layer
 * (a PaymentProvider whose getStatus returns a scripted body) and the courier
 * (a ShipmentProvider that counts bookings). Every guarantee under test is the
 * database's, not a mock's.
 */
import { randomUUID } from 'node:crypto'
import { GatewayTransactionStatus, PaymentStatus, ReservationStatus } from '@prisma/client'
import { GatewayStatusApplier } from '../../src/modules/payments/gateway/gateway-status-applier.service'
import { MidtransReconciliationWorker } from '../../src/modules/payments/gateway/midtrans-reconciliation.worker'
import type { MidtransConfig } from '../../src/modules/payments/gateway/midtrans.config'
import { PaymentGatewayPersistenceService } from '../../src/modules/payments/gateway/payment-gateway-persistence.service'
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory'
import { PaymentWebhookService } from '../../src/modules/payments/gateway/payment-webhook.service'
import { PaymentWebhookController } from '../../src/modules/payments/gateway/presentation/payment-webhook.controller'
import { buildMidtransSignature } from '../../src/modules/payments/gateway/domain/midtrans-signature.util'
import { InventoryReservationService } from '../../src/modules/inventory/inventory-reservation.service'
import { OrderCancellationService } from '../../src/modules/orders/order-cancellation.service'
import { PaymentSettlementService } from '../../src/modules/payments/settlement/payment-settlement.service'
import { ShipmentProviderFactory } from '../../src/modules/shipment/shipment-provider.factory'
import { ShipmentService } from '../../src/modules/shipment/shipment.service'
import { getWorld, seedScenario, type IntegrationWorld } from './world'

const SERVER_KEY = 'SB-Mid-server-INTEGRATION-ONLY' // fixture, never a real credential
const AMOUNT = 40000
const GROSS = '40000.00'

const MIDTRANS: MidtransConfig = {
  enabled: true, serverKey: SERVER_KEY, clientKey: 'ck', isProduction: false,
  baseUrl: 'https://api.sandbox.midtrans.com', timeoutMs: 5000, maxRetry: 2,
}

let world: IntegrationWorld
let ledger: PaymentGatewayPersistenceService
let inventory: InventoryReservationService
let settlement: PaymentSettlementService
let applier: GatewayStatusApplier
let webhook: PaymentWebhookService
let controller: PaymentWebhookController
let worker: MidtransReconciliationWorker
let shipments: ShipmentService
let cancellation: OrderCancellationService

/** Scripted Midtrans Status API. `raw` is what the real validator will inspect. */
const script = new Map<string, Record<string, unknown> | Error>()
let statusCalls = 0
/** Courier double: counts real booking attempts (§14). */
let courierCalls = 0

function buildServices() {
  const prisma = world.prisma

  const midtransProvider = {
    name: 'midtrans',
    supportedChannels: () => ['QRIS'],
    createCharge: async () => { throw new Error('not used') },
    cancel: async () => { throw new Error('not used') },
    mapStatus: () => PaymentStatus.PENDING,
    getStatus: async ({ providerReference }: { providerReference?: string | null }) => {
      statusCalls += 1
      const scripted = script.get(providerReference ?? '')
      if (scripted instanceof Error) throw scripted
      return { provider: 'midtrans', providerReference, status: PaymentStatus.PENDING, raw: scripted ?? null }
    },
  }
  const providers = new PaymentProviderFactory([midtransProvider as never])

  const courier = {
    name: 'paxel',
    createShipment: async () => {
      courierCalls += 1
      return { providerShipmentId: `psid-${randomUUID().slice(0, 8)}`, trackingNumber: `TRK-${randomUUID().slice(0, 8)}`, raw: {} }
    },
    cancelShipment: async () => undefined,
    trackShipment: async () => ({ status: 'IN_TRANSIT', raw: {} }),
    trackShipmentRaw: async () => ({ status: 'IN_TRANSIT', raw: {} }),
  }
  shipments = new ShipmentService(prisma, new ShipmentProviderFactory([courier as never]))

  ledger = new PaymentGatewayPersistenceService(prisma)
  inventory = new InventoryReservationService(prisma)
  // Wire cancellation the way production does — with the reservation service — so
  // releases actually transition InventoryReservation rows. `world.cancellation` is
  // deliberately bare in the shared harness and would silently skip them.
  cancellation = new OrderCancellationService(inventory)
  settlement = new PaymentSettlementService(prisma, shipments, inventory, cancellation)
  applier = new GatewayStatusApplier(settlement)
  webhook = new PaymentWebhookService(MIDTRANS, ledger, undefined, applier, providers)
  controller = new PaymentWebhookController(webhook)
  worker = new MidtransReconciliationWorker(
    prisma, providers, applier,
    { enabled: true, pollIntervalMs: 60_000, initialDelayMs: 30_000, batchSize: 50, minAgeMs: 0, healthLogIntervalMs: 300_000 },
    MIDTRANS,
  )
}

beforeAll(async () => {
  world = await getWorld()
  buildServices()
}, 300_000)

beforeEach(() => { statusCalls = 0; courierCalls = 0; script.clear() })

// ------------------------------------------------------------------ fixtures --

interface Charge {
  orderId: string
  paymentId: string
  productId: string
  gtxId: string
  providerOrderId: string
}

/** A real order + payment + RESERVED inventory + open Midtrans gateway attempt. */
async function charge(opts: { paymentStatus?: PaymentStatus; stock?: number; withShipment?: boolean } = {}): Promise<Charge> {
  const s = await seedScenario(world, {
    method: 'QRIS',
    paymentStatus: (opts.paymentStatus ?? PaymentStatus.PENDING) as 'PENDING',
    orderStatus: 'PENDING',
    stock: opts.stock ?? 10,
  })
  const providerOrderId = `${s.order.orderNumber}-${randomUUID().replace(/-/g, '').slice(0, 8)}`

  await world.prisma.inventoryReservation.create({
    data: { orderId: s.order.id, productId: s.productId, reservedQty: 1, status: ReservationStatus.RESERVED },
  })

  const gtx = await world.prisma.paymentGatewayTransaction.create({
    data: {
      paymentId: s.payment.id, provider: 'midtrans', channelCode: 'QRIS',
      providerOrderId, grossAmount: AMOUNT, status: GatewayTransactionStatus.PENDING,
      createdAt: new Date(Date.now() - 10 * 60_000),
    },
  })

  if (opts.withShipment) {
    const outlet = await world.prisma.outlet.create({
      data: { name: `Outlet ${randomUUID().slice(0, 6)}`, postalCode: '40111', isActive: true },
    })
    await world.prisma.order.update({
      where: { id: s.order.id },
      data: { outletId: outlet.id, shippingProvider: 'paxel' },
    })
    await world.prisma.address.updateMany({ where: { id: s.order.addressId }, data: { postalCode: '40115' } })
    await world.prisma.shipment.create({
      data: { orderId: s.order.id, provider: 'paxel', service: 'SAMEDAY', cost: 10000, status: 'RATE_SELECTED' },
    })
  }

  return { orderId: s.order.id, paymentId: s.payment.id, productId: s.productId, gtxId: gtx.id, providerOrderId }
}

const statusBody = (providerOrderId: string, over: Record<string, unknown> = {}) => ({
  order_id: providerOrderId,
  transaction_status: 'settlement',
  status_code: '200',
  gross_amount: GROSS,
  transaction_id: `trx-${randomUUID().slice(0, 8)}`,
  ...over,
})

/** A genuinely signed notification — the real verifier checks it. */
function notification(providerOrderId: string, over: Record<string, unknown> = {}) {
  const status_code = (over.status_code as string) ?? '200'
  const gross_amount = (over.gross_amount as string) ?? GROSS
  return {
    order_id: providerOrderId,
    status_code,
    gross_amount,
    signature_key: buildMidtransSignature(
      { orderId: providerOrderId, statusCode: status_code, grossAmount: gross_amount }, SERVER_KEY,
    ),
    transaction_status: 'settlement',
    transaction_id: `trx-${randomUUID().slice(0, 8)}`,
    ...over,
  } as never
}

const paymentOf = (id: string) => world.prisma.payment.findUniqueOrThrow({ where: { id } })
const orderOf = (id: string) => world.prisma.order.findUniqueOrThrow({ where: { id } })
const paidEvents = (paymentId: string, eventName = 'payment.paid') =>
  world.prisma.outboxEvent.count({ where: { aggregateId: paymentId, eventName } })
const reservations = (orderId: string, status: ReservationStatus) =>
  world.prisma.inventoryReservation.count({ where: { orderId, status } })

// ============================================================ §4 settlement ==

describe('§4 real webhook settlement, end to end', () => {
  it('drives payment, order, inventory, shipment, webhook state and outbox in the real DB', async () => {
    const c = await charge({ withShipment: true })
    script.set(c.providerOrderId, statusBody(c.providerOrderId))

    const ack = await controller.midtrans(notification(c.providerOrderId))
    expect(ack).toEqual({ received: true, handled: false })

    expect((await paymentOf(c.paymentId)).status).toBe('PAID')
    // Settlement moves PENDING -> PROCESSING; the shipment booking then advances it
    // to SHIPPED. Both are legal forward transitions.
    expect(['PROCESSING', 'SHIPPED']).toContain((await orderOf(c.orderId)).status)
    expect(await reservations(c.orderId, ReservationStatus.COMMITTED)).toBe(1)
    expect(await paidEvents(c.paymentId)).toBe(1)

    // Stock actually moved (legacy Product.stock path — no ProductInventory row).
    expect((await world.prisma.product.findUniqueOrThrow({ where: { id: c.productId } })).stock).toBe(9)

    // Exactly one shipment, booked once.
    expect(await world.prisma.shipment.count({ where: { orderId: c.orderId } })).toBe(1)
    expect(courierCalls).toBe(1)

    const event = await world.prisma.paymentWebhookEvent.findFirstOrThrow({ where: { providerOrderId: c.providerOrderId } })
    expect(event.settlementState).toBe('SETTLED')

    const gtx = await world.prisma.paymentGatewayTransaction.findUniqueOrThrow({ where: { id: c.gtxId } })
    expect(gtx.status).toBe('SETTLEMENT')
    expect(gtx.providerStatus).toBe('settlement')
  })
})

// ============================================================ §5 duplicates ==

describe('§5 duplicate delivery of the SAME notification', () => {
  it.each([1, 2, 5, 10])('%i identical deliveries produce exactly one of everything', async (times) => {
    const c = await charge({ withShipment: true })
    script.set(c.providerOrderId, statusBody(c.providerOrderId))
    const body = notification(c.providerOrderId)

    for (let i = 0; i < times; i++) await controller.midtrans(body)

    expect((await paymentOf(c.paymentId)).status).toBe('PAID')
    expect(await reservations(c.orderId, ReservationStatus.COMMITTED)).toBe(1)
    expect(await paidEvents(c.paymentId)).toBe(1)
    expect(await world.prisma.shipment.count({ where: { orderId: c.orderId, trackingNumber: { not: null } } })).toBe(1)
    expect(courierCalls).toBe(1)
    // The fingerprint unique index admits the notification once.
    expect(await world.prisma.paymentWebhookEvent.count({ where: { providerOrderId: c.providerOrderId } })).toBe(1)
  })
})

// =========================================================== §6 concurrency ==

describe('§6 concurrent identical webhooks', () => {
  it('10 in parallel: one transition, one commit, one shipment, one event, no deadlock', async () => {
    const c = await charge({ withShipment: true })
    script.set(c.providerOrderId, statusBody(c.providerOrderId))
    const body = notification(c.providerOrderId)

    const results = await Promise.all(
      Array.from({ length: 10 }, () => controller.midtrans(body).catch((e: Error) => e)),
    )
    const errors = results.filter((r) => r instanceof Error) as Error[]
    // Losers may surface as 503 (retryable) but must never be a deadlock.
    for (const e of errors) expect(e.message).not.toMatch(/deadlock/i)

    expect((await paymentOf(c.paymentId)).status).toBe('PAID')
    expect(['PROCESSING', 'SHIPPED']).toContain((await orderOf(c.orderId)).status)
    expect(await reservations(c.orderId, ReservationStatus.COMMITTED)).toBe(1)
    expect(await paidEvents(c.paymentId)).toBe(1)
    expect(courierCalls).toBe(1)
    expect(await world.prisma.paymentWebhookEvent.count({ where: { providerOrderId: c.providerOrderId } })).toBe(1)
  })
})

// ============================================== §7–§10 cross-path races ======

describe('§7 webhook vs reconciliation', () => {
  it('both settle the same charge concurrently — exactly one wins', async () => {
    const c = await charge({ withShipment: true })
    script.set(c.providerOrderId, statusBody(c.providerOrderId))

    const [a, b] = await Promise.all([
      controller.midtrans(notification(c.providerOrderId)).catch((e: Error) => e),
      worker.reconcile().catch((e: Error) => e),
    ])
    expect(a).toBeDefined()
    expect(b).toBeDefined()

    expect((await paymentOf(c.paymentId)).status).toBe('PAID')
    expect(['PROCESSING', 'SHIPPED']).toContain((await orderOf(c.orderId)).status)
    expect(await reservations(c.orderId, ReservationStatus.COMMITTED)).toBe(1)
    expect(await paidEvents(c.paymentId)).toBe(1)
    expect(courierCalls).toBe(1)
  })
})

describe('§8 reconciliation vs reconciliation', () => {
  it('two independent worker instances converge on one transition', async () => {
    const c = await charge({ withShipment: true })
    script.set(c.providerOrderId, statusBody(c.providerOrderId))

    const second = new MidtransReconciliationWorker(
      world.prisma,
      new PaymentProviderFactory([{
        name: 'midtrans', supportedChannels: () => ['QRIS'],
        createCharge: async () => { throw new Error('x') }, cancel: async () => { throw new Error('x') },
        mapStatus: () => PaymentStatus.PENDING,
        getStatus: async ({ providerReference }: { providerReference?: string | null }) => {
          statusCalls += 1
          return { provider: 'midtrans', providerReference, status: PaymentStatus.PENDING, raw: script.get(providerReference ?? '') ?? null }
        },
      } as never]),
      applier,
      { enabled: true, pollIntervalMs: 60_000, initialDelayMs: 30_000, batchSize: 50, minAgeMs: 0, healthLogIntervalMs: 300_000 },
      MIDTRANS,
    )

    const [t1, t2] = await Promise.all([worker.reconcile(), second.reconcile()])
    // Both may discover the candidate; only one may transition it.
    expect(t1.transitioned + t2.transitioned).toBeLessThanOrEqual(1)

    expect((await paymentOf(c.paymentId)).status).toBe('PAID')
    expect(await paidEvents(c.paymentId)).toBe(1)
    expect(await reservations(c.orderId, ReservationStatus.COMMITTED)).toBe(1)
    expect(courierCalls).toBe(1)
  })
})

describe('§9 reconciliation vs admin verify', () => {
  it('one legal transition, one set of side effects', async () => {
    const c = await charge({ withShipment: true })
    script.set(c.providerOrderId, statusBody(c.providerOrderId))

    // Admin verify goes through the SAME shared settlement service.
    const adminSettle = () => settlement.settle(c.paymentId, { kind: 'ADMIN', adminId: randomUUID() })

    const results = await Promise.all([
      worker.reconcile().catch((e: Error) => e),
      adminSettle().catch((e: Error) => e),
    ])
    expect(results).toHaveLength(2)

    expect((await paymentOf(c.paymentId)).status).toBe('PAID')
    expect(await paidEvents(c.paymentId)).toBe(1)
    expect(await reservations(c.orderId, ReservationStatus.COMMITTED)).toBe(1)
    expect(courierCalls).toBe(1)
  })
})

describe('§10 reconciliation vs admin cancel', () => {
  it('no resurrection, no double restock, no negative stock', async () => {
    const c = await charge()
    script.set(c.providerOrderId, statusBody(c.providerOrderId))
    const before = (await world.prisma.product.findUniqueOrThrow({ where: { id: c.productId } })).stock

    await Promise.all([
      worker.reconcile().catch((e: Error) => e),
      settlement.fail(c.paymentId, { kind: 'SYSTEM', source: 'admin.rejectPayment' }, 'admin reject').catch((e: Error) => e),
    ])

    const payment = await paymentOf(c.paymentId)
    const order = await orderOf(c.orderId)
    const product = await world.prisma.product.findUniqueOrThrow({ where: { id: c.productId } })

    // Exactly one of the two legal outcomes, never a mixture.
    if (payment.status === 'PAID') {
      expect(['PROCESSING', 'SHIPPED']).toContain(order.status)
      expect(await paidEvents(c.paymentId)).toBe(1)
      expect(await paidEvents(c.paymentId, 'payment.failed')).toBe(0)
      expect(product.stock).toBe(before - 1) // committed
    } else {
      expect(payment.status).toBe('FAILED')
      expect(order.status).toBe('CANCELLED')
      expect(await paidEvents(c.paymentId)).toBe(0)
      expect(await paidEvents(c.paymentId, 'payment.failed')).toBe(1)
      expect(product.stock).toBe(before) // released, not double-restocked
    }
    expect(product.stock).toBeGreaterThanOrEqual(0)
    expect(await reservations(c.orderId, ReservationStatus.RESERVED)).toBe(0)
  })
})

// ======================================================== §11 failure/expire ==

describe('§11 terminal provider states against the real DB', () => {
  it.each(['deny', 'failure', 'cancel'])('%s → FAILED, reservation released, payment.failed once', async (status) => {
    const c = await charge()
    script.set(c.providerOrderId, statusBody(c.providerOrderId, { transaction_status: status }))
    const before = (await world.prisma.product.findUniqueOrThrow({ where: { id: c.productId } })).stock

    await controller.midtrans(notification(c.providerOrderId, { transaction_status: status }))

    expect((await paymentOf(c.paymentId)).status).toBe('FAILED')
    expect((await orderOf(c.orderId)).status).toBe('CANCELLED')
    expect(await paidEvents(c.paymentId, 'payment.failed')).toBe(1)
    expect(await paidEvents(c.paymentId)).toBe(0)
    expect(await reservations(c.orderId, ReservationStatus.RESERVED)).toBe(0)
    // Released, never committed → stock untouched, never decremented then restocked.
    expect((await world.prisma.product.findUniqueOrThrow({ where: { id: c.productId } })).stock).toBe(before)
  })

  it('expire → EXPIRED, reservation released AS EXPIRED, payment.expired once', async () => {
    const c = await charge()
    script.set(c.providerOrderId, statusBody(c.providerOrderId, { transaction_status: 'expire' }))

    await controller.midtrans(notification(c.providerOrderId, { transaction_status: 'expire' }))

    expect((await paymentOf(c.paymentId)).status).toBe('EXPIRED')
    expect(await paidEvents(c.paymentId, 'payment.expired')).toBe(1)
    expect(await reservations(c.orderId, ReservationStatus.EXPIRED)).toBe(1)
    expect(await reservations(c.orderId, ReservationStatus.RESERVED)).toBe(0)
  })
})

// ========================================================== §12 out-of-order ==

describe('§12 terminal states never regress (real CAS)', () => {
  it('settlement then pending / failure / expire leaves PAID intact', async () => {
    const c = await charge({ withShipment: true })
    script.set(c.providerOrderId, statusBody(c.providerOrderId))
    await controller.midtrans(notification(c.providerOrderId))
    expect((await paymentOf(c.paymentId)).status).toBe('PAID')

    for (const later of ['pending', 'failure', 'expire']) {
      script.set(c.providerOrderId, statusBody(c.providerOrderId, { transaction_status: later }))
      await controller.midtrans(notification(c.providerOrderId, { transaction_status: later, status_code: '201' }))
      expect((await paymentOf(c.paymentId)).status).toBe('PAID')
    }

    expect(['PROCESSING', 'SHIPPED']).toContain((await orderOf(c.orderId)).status)
    expect(await paidEvents(c.paymentId)).toBe(1)
    expect(await paidEvents(c.paymentId, 'payment.failed')).toBe(0)
    expect(await paidEvents(c.paymentId, 'payment.expired')).toBe(0)
    expect(courierCalls).toBe(1)
  })

  it('FAILED then settlement, and EXPIRED then settlement, both refuse', async () => {
    const failed = await charge()
    script.set(failed.providerOrderId, statusBody(failed.providerOrderId, { transaction_status: 'deny' }))
    await controller.midtrans(notification(failed.providerOrderId, { transaction_status: 'deny' }))
    expect((await paymentOf(failed.paymentId)).status).toBe('FAILED')

    script.set(failed.providerOrderId, statusBody(failed.providerOrderId))
    await controller.midtrans(notification(failed.providerOrderId))
    expect((await paymentOf(failed.paymentId)).status).toBe('FAILED') // no resurrection
    expect(await paidEvents(failed.paymentId)).toBe(0)

    const expired = await charge()
    await world.prisma.payment.update({ where: { id: expired.paymentId }, data: { status: PaymentStatus.EXPIRED } })
    script.set(expired.providerOrderId, statusBody(expired.providerOrderId))
    await controller.midtrans(notification(expired.providerOrderId))
    expect((await paymentOf(expired.paymentId)).status).toBe('EXPIRED')
    expect(await paidEvents(expired.paymentId)).toBe(0)
  })
})

// ========================================================= §13 inventory =====

describe('§13 inventory under real concurrency', () => {
  it('concurrent commit and release on one order leave a consistent, non-negative result', async () => {
    const c = await charge()
    script.set(c.providerOrderId, statusBody(c.providerOrderId))
    const before = (await world.prisma.product.findUniqueOrThrow({ where: { id: c.productId } })).stock

    // Settlement (commit) racing rejection (release) on the same reservation.
    await Promise.all([
      controller.midtrans(notification(c.providerOrderId)).catch((e: Error) => e),
      settlement.fail(c.paymentId, { kind: 'SYSTEM', source: 'admin.rejectPayment' }, 'race').catch((e: Error) => e),
    ])

    const product = await world.prisma.product.findUniqueOrThrow({ where: { id: c.productId } })
    const committed = await reservations(c.orderId, ReservationStatus.COMMITTED)
    const released = await reservations(c.orderId, ReservationStatus.RELEASED)

    expect(product.stock).toBeGreaterThanOrEqual(0)
    expect(committed + released).toBe(1)          // never both, never neither
    expect(await reservations(c.orderId, ReservationStatus.RESERVED)).toBe(0)
    expect(product.stock).toBe(committed === 1 ? before - 1 : before)
  })

  it('a committed reservation is never released, and never committed twice', async () => {
    const c = await charge({ withShipment: true })
    script.set(c.providerOrderId, statusBody(c.providerOrderId))
    const before = (await world.prisma.product.findUniqueOrThrow({ where: { id: c.productId } })).stock

    await controller.midtrans(notification(c.providerOrderId))
    // Replays after a successful settlement must not touch stock again.
    await controller.midtrans(notification(c.providerOrderId))
    await worker.reconcile()

    expect((await world.prisma.product.findUniqueOrThrow({ where: { id: c.productId } })).stock).toBe(before - 1)
    expect(await reservations(c.orderId, ReservationStatus.COMMITTED)).toBe(1)
    expect(await reservations(c.orderId, ReservationStatus.RELEASED)).toBe(0)
  })
})

// ========================================================== §14 shipment =====

describe('§14 shipment under real concurrency', () => {
  it('two concurrent settlement paths book the courier exactly once', async () => {
    const c = await charge({ withShipment: true })
    script.set(c.providerOrderId, statusBody(c.providerOrderId))

    await Promise.all([
      controller.midtrans(notification(c.providerOrderId)).catch((e: Error) => e),
      worker.reconcile().catch((e: Error) => e),
      settlement.settle(c.paymentId, { kind: 'ADMIN', adminId: randomUUID() }).catch((e: Error) => e),
    ])

    expect(await world.prisma.shipment.count({ where: { orderId: c.orderId } })).toBe(1)
    expect(courierCalls).toBe(1) // the CAS claim gates the provider call itself
    const shipment = await world.prisma.shipment.findFirstOrThrow({ where: { orderId: c.orderId } })
    expect(shipment.trackingNumber).toMatch(/^TRK-/)
  })

  it('Shipment.orderId is UNIQUE in the real schema', async () => {
    const c = await charge({ withShipment: true })
    await expect(
      world.prisma.shipment.create({ data: { orderId: c.orderId, provider: 'paxel', service: 'SAMEDAY', cost: 10000, status: 'RATE_SELECTED' } }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })
})

// ============================================================ §15 outbox =====

describe('§15 outbox rows in MySQL', () => {
  it('carries a unique id, version 1, correct routing and source', async () => {
    const c = await charge({ withShipment: true })
    script.set(c.providerOrderId, statusBody(c.providerOrderId))
    await controller.midtrans(notification(c.providerOrderId))

    const events = await world.prisma.outboxEvent.findMany({ where: { aggregateId: c.paymentId } })
    expect(events).toHaveLength(1)
    const [e] = events
    expect(e.eventName).toBe('payment.paid')
    expect(e.eventVersion).toBe(1)
    expect(e.exchange).toBe('payments')
    expect(e.routingKey).toBe('payment.paid')
    expect(e.aggregateType).toBe('payment')
    expect(e.occurredAt).toBeInstanceOf(Date)
    expect((e.metadata as Record<string, unknown>).source).toBe('payments.webhook.midtrans')

    // Ids are unique across the whole table (DB-enforced primary key).
    const all = await world.prisma.outboxEvent.findMany({ select: { id: true } })
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length)
  })
})

// ================================================= §16 reconciliation recovery ==

describe('§16 recovery after a lost webhook (proves the Phase 5F-1 fix)', () => {
  it('settles a charge whose webhook never arrived', async () => {
    const c = await charge({ withShipment: true })
    script.set(c.providerOrderId, statusBody(c.providerOrderId))

    // No webhook at all — only the worker runs.
    const tick = await worker.reconcile()
    expect(tick.transitioned).toBeGreaterThanOrEqual(1)

    expect((await paymentOf(c.paymentId)).status).toBe('PAID')
    expect(['PROCESSING', 'SHIPPED']).toContain((await orderOf(c.orderId)).status)
    expect(await paidEvents(c.paymentId)).toBe(1)
    expect(await reservations(c.orderId, ReservationStatus.COMMITTED)).toBe(1)
  })

  it('recovers a charge whose earlier notification concluded NOT_ELIGIBLE', async () => {
    const c = await charge({ withShipment: true })

    // 1. A `pending` webhook concludes NOT_ELIGIBLE.
    script.set(c.providerOrderId, statusBody(c.providerOrderId, { transaction_status: 'pending', status_code: '201' }))
    await controller.midtrans(notification(c.providerOrderId, { transaction_status: 'pending', status_code: '201' }))

    const first = await world.prisma.paymentWebhookEvent.findFirstOrThrow({ where: { providerOrderId: c.providerOrderId } })
    expect(first.settlementState).toBe('NOT_ELIGIBLE')
    expect((await paymentOf(c.paymentId)).status).toBe('PENDING')

    // 2. The customer pays; the settlement webhook is LOST. Before the 5F-1 fix the
    //    worker skipped this charge forever and the money was never recognised.
    script.set(c.providerOrderId, statusBody(c.providerOrderId, { transaction_status: 'settlement' }))
    const tick = await worker.reconcile()

    expect(tick.transitioned).toBeGreaterThanOrEqual(1)
    expect((await paymentOf(c.paymentId)).status).toBe('PAID')
    expect(await paidEvents(c.paymentId)).toBe(1)
    expect(await reservations(c.orderId, ReservationStatus.COMMITTED)).toBe(1)
  })
})

// ========================================================= §17 disabled gate ==

describe('§17 disabled configuration', () => {
  const cfg = { enabled: true, pollIntervalMs: 60_000, initialDelayMs: 30_000, batchSize: 50, minAgeMs: 0, healthLogIntervalMs: 300_000 }

  it('MIDTRANS_ENABLED=false keeps the worker down (no repeated provider lookups)', async () => {
    const c = await charge()
    script.set(c.providerOrderId, statusBody(c.providerOrderId))

    const off = new MidtransReconciliationWorker(
      world.prisma, new PaymentProviderFactory([]), applier, cfg, { ...MIDTRANS, enabled: false },
    )
    off.onApplicationBootstrap()
    await new Promise((r) => setTimeout(r, 200))

    expect(statusCalls).toBe(0)
    expect((await paymentOf(c.paymentId)).status).toBe('PENDING')
    await off.onModuleDestroy()
  })

  it('MIDTRANS_RECONCILIATION_ENABLED=false keeps the worker down', async () => {
    const c = await charge()
    script.set(c.providerOrderId, statusBody(c.providerOrderId))

    const off = new MidtransReconciliationWorker(
      world.prisma, new PaymentProviderFactory([]), applier, { ...cfg, enabled: false }, MIDTRANS,
    )
    off.onApplicationBootstrap()
    await new Promise((r) => setTimeout(r, 200))

    expect(statusCalls).toBe(0)
    expect((await paymentOf(c.paymentId)).status).toBe('PENDING')
    await off.onModuleDestroy()
  })

  it('a disabled gateway rejects notifications with 503 and mutates nothing', async () => {
    const c = await charge()
    const disabled = new PaymentWebhookService({ ...MIDTRANS, enabled: false }, ledger, undefined, applier, new PaymentProviderFactory([]))
    await expect(disabled.handleMidtransNotification(notification(c.providerOrderId))).rejects.toThrow(/not enabled/i)

    expect((await paymentOf(c.paymentId)).status).toBe('PENDING')
    expect(await world.prisma.paymentWebhookEvent.count({ where: { providerOrderId: c.providerOrderId } })).toBe(0)
  })
})

// ============================================ §18 manual BANK_TRANSFER ========

describe('§18 manual BANK_TRANSFER regression against the real DB', () => {
  it('upload token → receipt → admin verify still works, with no gateway involvement', async () => {
    const s = await seedScenario(world, { method: 'BANK_TRANSFER', paymentStatus: 'PENDING', orderStatus: 'PENDING' })

    const token = await world.prisma.$transaction((tx) => world.uploadTokens.issue(tx, s.payment.id))
    expect(token.rawToken).toBeTruthy()

    // The real token-scoped upload path (what the customer actually uses).
    await world.payments.submitReceiptByToken(token.rawToken, { paymentProofUrl: 'https://cdn.test/receipt.jpg' } as never)
    expect((await paymentOf(s.payment.id)).status).toBe('WAITING_VERIFICATION')

    await world.admin.verifyPayment(s.payment.id, randomUUID(), {} as never)

    expect((await paymentOf(s.payment.id)).status).toBe('PAID')
    expect((await orderOf(s.order.id)).status).toBe('PROCESSING')
    expect(await paidEvents(s.payment.id)).toBe(1)

    // No gateway artefacts, and no Midtrans call was made anywhere in this flow.
    expect(await world.prisma.paymentGatewayTransaction.count({ where: { paymentId: s.payment.id } })).toBe(0)
    expect(statusCalls).toBe(0)
  })

  it('a manual payment is never a reconciliation candidate', async () => {
    const s = await seedScenario(world, { method: 'BANK_TRANSFER', paymentStatus: 'PENDING', orderStatus: 'PENDING' })
    await worker.reconcile()

    expect((await paymentOf(s.payment.id)).status).toBe('PENDING')
    expect(await world.prisma.paymentGatewayTransaction.count({ where: { paymentId: s.payment.id } })).toBe(0)
  })
})

// ================================================================ §19 COD =====

describe('§19 historical COD stays readable', () => {
  it('an existing COD order and payment can still be read back', async () => {
    const s = await seedScenario(world, { method: 'COD', paymentStatus: 'PENDING', orderStatus: 'PENDING' })
    const payment = await paymentOf(s.payment.id)

    expect(payment.method).toBe('COD')
    expect((await orderOf(s.order.id)).paymentMethod).toBe('COD')
    // And it is never a gateway/reconciliation candidate.
    await worker.reconcile()
    expect((await paymentOf(s.payment.id)).status).toBe('PENDING')
  })
})

// =========================================================== §20 security =====

describe('§20 security at the endpoint', () => {
  it('an invalid signature is rejected and mutates nothing', async () => {
    const c = await charge()
    script.set(c.providerOrderId, statusBody(c.providerOrderId))
    const forged = { ...(notification(c.providerOrderId) as Record<string, unknown>), signature_key: 'f'.repeat(128) }

    await expect(controller.midtrans(forged as never)).rejects.toMatchObject({ status: 401 })

    expect((await paymentOf(c.paymentId)).status).toBe('PENDING')
    expect(await world.prisma.paymentWebhookEvent.count({ where: { providerOrderId: c.providerOrderId } })).toBe(0)
    expect(statusCalls).toBe(0) // an unsigned request cannot even reach Midtrans
  })

  it('a signature computed with the WRONG server key is rejected', async () => {
    const c = await charge()
    const forged = {
      ...(notification(c.providerOrderId) as Record<string, unknown>),
      signature_key: buildMidtransSignature(
        { orderId: c.providerOrderId, statusCode: '200', grossAmount: GROSS }, 'ATTACKER-KEY',
      ),
    }
    await expect(controller.midtrans(forged as never)).rejects.toMatchObject({ status: 401 })
    expect((await paymentOf(c.paymentId)).status).toBe('PENDING')
  })

  it('a tampered amount fails the signature and never settles', async () => {
    const c = await charge()
    script.set(c.providerOrderId, statusBody(c.providerOrderId))
    const body = notification(c.providerOrderId) as Record<string, unknown>
    await expect(controller.midtrans({ ...body, gross_amount: '1.00' } as never)).rejects.toMatchObject({ status: 401 })
    expect((await paymentOf(c.paymentId)).status).toBe('PENDING')
  })

  it('no persisted webhook snapshot contains a signature or a key', async () => {
    const c = await charge({ withShipment: true })
    script.set(c.providerOrderId, statusBody(c.providerOrderId))
    await controller.midtrans(notification(c.providerOrderId))

    const event = await world.prisma.paymentWebhookEvent.findFirstOrThrow({ where: { providerOrderId: c.providerOrderId } })
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('signature')
    expect(serialized).not.toContain(SERVER_KEY)
    expect(serialized).not.toContain('Mid-server')
    expect(serialized).not.toContain('Authorization')
  })

  it('the gateway ledger never persists a credential', async () => {
    const rows = await world.prisma.paymentGatewayTransaction.findMany({ take: 50 })
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(SERVER_KEY)
    expect(serialized).not.toContain('Mid-server')
    expect(serialized).not.toContain('signature_key')
  })
})
