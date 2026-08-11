/**
 * Phase 5J.1 — RESUMING a gateway payment against REAL MySQL.
 *
 * The unit spec proves the resume logic with a mocked ledger. This one proves the
 * claim that actually matters operationally: after N resumes there is still
 * exactly ONE PaymentGatewayTransaction row in the database, carrying the same
 * providerOrderId and the same QR string it was charged with.
 *
 * Everything here is the production code path against the Testcontainers
 * database — real Prisma, real rows, real unique constraints. The only double is
 * the Midtrans provider, and it exists solely to FAIL LOUDLY if resume ever
 * reaches for it.
 *
 * REQUIRES DOCKER (see jest.integration.config.js).
 */
import { randomUUID } from 'node:crypto'
import { NotFoundException } from '@nestjs/common'
import { GatewayTransactionStatus, PaymentStatus } from '@prisma/client'
import { PaymentGatewayPersistenceService } from '../../src/modules/payments/gateway/payment-gateway-persistence.service'
import { PaymentInitiationService } from '../../src/modules/payments/gateway/payment-initiation.service'
import { PaymentChannelRegistry } from '../../src/modules/payments/gateway/payment-channel.registry'
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory'
import { getWorld, seedScenario, type IntegrationWorld } from './world'

const AMOUNT = 40000
const QR_STRING = '00020101021226670016COM.PHASE5J1.PROBE-PERSISTED-AT-CHECKOUT'

let world: IntegrationWorld
let ledger: PaymentGatewayPersistenceService
let initiation: PaymentInitiationService

/** Counts every outbound gateway call. Resume must leave all of these at zero. */
let providerCalls = { createCharge: 0, getStatus: 0, cancel: 0 }

function buildServices() {
  ledger = new PaymentGatewayPersistenceService(world.prisma)

  const midtrans = {
    name: 'midtrans',
    supportedChannels: () => ['QRIS'],
    mapStatus: () => PaymentStatus.PENDING,
    createCharge: async () => {
      providerCalls.createCharge += 1
      throw new Error('resume must never charge')
    },
    getStatus: async () => {
      providerCalls.getStatus += 1
      throw new Error('resume must never read provider status')
    },
    cancel: async () => {
      providerCalls.cancel += 1
      throw new Error('resume must never cancel')
    },
  }
  const providers = new PaymentProviderFactory([midtrans as never])
  const channels = new PaymentChannelRegistry(providers)
  initiation = new PaymentInitiationService(world.prisma, channels, providers, ledger)
}

/**
 * Seed an order whose gateway charge already happened — i.e. exactly the state
 * checkout leaves behind. Written through the REAL persistence service, so the
 * row under test is the row production would have created.
 */
async function seedChargedQris(over: { expiryAt?: Date; paymentStatus?: PaymentStatus } = {}) {
  const scenario = await seedScenario(world, { paymentStatus: 'PENDING' })

  const attempt = await ledger.createPendingTransaction({
    paymentId: scenario.payment.id,
    provider: 'midtrans',
    channelCode: 'QRIS',
    grossAmount: AMOUNT,
    providerOrderId: scenario.order.orderNumber,
    metadata: { method: 'GATEWAY', channel: 'QRIS' },
  })

  // The provider order id Midtrans actually signed: {orderNumber}-{attemptId8}.
  const providerOrderId = `${scenario.order.orderNumber}-${attempt.id.slice(0, 8)}`
  await ledger.updateGatewayResponse(attempt.id, {
    status: GatewayTransactionStatus.PENDING,
    providerOrderId,
    providerReference: `ref-${randomUUID().slice(0, 8)}`,
    providerTransactionId: randomUUID(),
    qrString: QR_STRING,
    vaNumber: null,
    redirectUrl: null,
    deeplinkUrl: null,
    expiryAt: over.expiryAt ?? new Date(Date.now() + 15 * 60_000),
  })

  if (over.paymentStatus) {
    await world.prisma.payment.update({
      where: { id: scenario.payment.id },
      data: { status: over.paymentStatus },
    })
  }

  return { scenario, attemptId: attempt.id, providerOrderId }
}

/** The DB-level assertion the staging database would otherwise have given us. */
async function attemptRowsFor(paymentId: string) {
  return world.prisma.paymentGatewayTransaction.findMany({
    where: { paymentId },
    orderBy: { createdAt: 'asc' },
  })
}

beforeAll(async () => {
  world = await getWorld()
  buildServices()
}, 180_000)

beforeEach(() => {
  providerCalls = { createCharge: 0, getStatus: 0, cancel: 0 }
})

// ============================================ §5 duplicate-charge safety =====

describe('N resumes never become N charges', () => {
  it.each([[1], [2], [5]])('%i consecutive resume(s) leave exactly one attempt row', async (n) => {
    const { scenario, attemptId, providerOrderId } = await seedChargedQris()

    const results: Awaited<ReturnType<PaymentInitiationService['getInstructions']>>[] = []
    for (let i = 0; i < n; i += 1) {
      results.push(await initiation.getInstructions(scenario.payment.id, scenario.userId))
    }

    // Every resume returned the SAME persisted attempt.
    for (const result of results) {
      expect(result.status).toBe(PaymentStatus.PENDING)
      expect(result.expired).toBe(false)
      expect(result.gateway!.qrString).toBe(QR_STRING)
    }
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true)

    // And the DATABASE still holds exactly one, unchanged.
    const rows = await attemptRowsFor(scenario.payment.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(attemptId)
    expect(rows[0].providerOrderId).toBe(providerOrderId)
    expect(rows[0].qrString).toBe(QR_STRING)

    expect(providerCalls).toEqual({ createCharge: 0, getStatus: 0, cancel: 0 })
  })

  it('two PARALLEL resumes (the two-tab case) still leave exactly one attempt row', async () => {
    const { scenario, attemptId, providerOrderId } = await seedChargedQris()

    const [tabA, tabB] = await Promise.all([
      initiation.getInstructions(scenario.payment.id, scenario.userId),
      initiation.getInstructions(scenario.payment.id, scenario.userId),
    ])

    // Both tabs see the identical attempt.
    expect(tabA).toEqual(tabB)
    expect(tabA.gateway!.qrString).toBe(QR_STRING)

    const rows = await attemptRowsFor(scenario.payment.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(attemptId)
    expect(rows[0].providerOrderId).toBe(providerOrderId)
    expect(providerCalls).toEqual({ createCharge: 0, getStatus: 0, cancel: 0 })
  })

  it('nothing on the attempt row is mutated by resuming', async () => {
    const { scenario } = await seedChargedQris()
    const before = (await attemptRowsFor(scenario.payment.id))[0]

    await initiation.getInstructions(scenario.payment.id, scenario.userId)
    await initiation.getInstructions(scenario.payment.id, scenario.userId)

    const after = (await attemptRowsFor(scenario.payment.id))[0]
    // Including updatedAt — a resume that touched the row would bump it.
    expect(after).toEqual(before)
  })
})

// ================================================= §8 PAID safety (real DB) ==

describe('a PAID payment is never payable again', () => {
  it('returns gateway: null / status: PAID even though the QR row still exists', async () => {
    const { scenario, attemptId } = await seedChargedQris({ paymentStatus: PaymentStatus.PAID })

    const result = await initiation.getInstructions(scenario.payment.id, scenario.userId)

    expect(result).toEqual({ gateway: null, status: PaymentStatus.PAID, expired: false })

    // The row is deliberately still there — the QR simply must not be handed out.
    const rows = await attemptRowsFor(scenario.payment.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(attemptId)
    expect(rows[0].qrString).toBe(QR_STRING)
    expect(providerCalls).toEqual({ createCharge: 0, getStatus: 0, cancel: 0 })
  })

  it.each([[PaymentStatus.FAILED], [PaymentStatus.EXPIRED], [PaymentStatus.REFUNDED]])(
    '%s is likewise not payable, and creates no replacement attempt',
    async (status) => {
      const { scenario } = await seedChargedQris({ paymentStatus: status })

      const result = await initiation.getInstructions(scenario.payment.id, scenario.userId)

      expect(result.gateway).toBeNull()
      expect(result.status).toBe(status)
      expect(await attemptRowsFor(scenario.payment.id)).toHaveLength(1)
      expect(providerCalls).toEqual({ createCharge: 0, getStatus: 0, cancel: 0 })
    },
  )
})

// ==================================================== §10 expiry (real DB) ===

describe('expiry is decided by the server against the persisted deadline', () => {
  it('an elapsed attempt is not payable and is NOT replaced by a new charge', async () => {
    const { scenario, attemptId } = await seedChargedQris({ expiryAt: new Date(Date.now() - 60_000) })

    const result = await initiation.getInstructions(scenario.payment.id, scenario.userId)

    expect(result.gateway).toBeNull()
    expect(result.expired).toBe(true)
    // Payment.status is still PENDING — the worker has not run yet.
    expect(result.status).toBe(PaymentStatus.PENDING)

    const rows = await attemptRowsFor(scenario.payment.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(attemptId)
    expect(providerCalls).toEqual({ createCharge: 0, getStatus: 0, cancel: 0 })
  })

  it('an attempt still inside its window is payable', async () => {
    const { scenario } = await seedChargedQris({ expiryAt: new Date(Date.now() + 60_000) })

    const result = await initiation.getInstructions(scenario.payment.id, scenario.userId)
    expect(result.gateway).not.toBeNull()
    expect(result.expired).toBe(false)
  })
})

// ================================================ §12 authorization / IDOR ===

describe('a customer cannot resume another customer\'s payment', () => {
  it('404s for a different real user, and leaks nothing about the payment', async () => {
    const { scenario } = await seedChargedQris()
    const intruder = await seedScenario(world) // a genuinely different user row

    await expect(
      initiation.getInstructions(scenario.payment.id, intruder.userId),
    ).rejects.toBeInstanceOf(NotFoundException)

    // Same generic error as a payment that does not exist at all — no oracle.
    await expect(
      initiation.getInstructions(randomUUID(), intruder.userId),
    ).rejects.toBeInstanceOf(NotFoundException)

    expect(providerCalls).toEqual({ createCharge: 0, getStatus: 0, cancel: 0 })
  })

  it('a soft-deleted payment is invisible even to its owner', async () => {
    const { scenario } = await seedChargedQris()
    await world.prisma.payment.update({
      where: { id: scenario.payment.id },
      data: { deletedAt: new Date() },
    })

    await expect(
      initiation.getInstructions(scenario.payment.id, scenario.userId),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})
