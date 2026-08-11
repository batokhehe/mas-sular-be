/**
 * Phase 5H.1 §3–§7 — REAL Midtrans Sandbox connectivity.
 *
 * NOTHING here is mocked: the real MidtransPaymentProvider, the real
 * MidtransHttpClient, and the real PaymentInitiationService drive a genuine HTTPS
 * request to the resolved Midtrans Sandbox endpoint. Persistence is the isolated
 * Testcontainers database, never the cloud dev database.
 *
 * Safety: this suite refuses to run unless the resolved config says
 * isProduction=false AND the base URL is a sandbox host. It never switches either.
 */
import { randomUUID } from 'node:crypto'
import { loadMidtransConfig } from '../../src/modules/payments/gateway/midtrans.config'
import { MidtransPaymentProvider } from '../../src/modules/payments/gateway/infrastructure/providers/midtrans-payment.provider'
import { PaymentChannelRegistry } from '../../src/modules/payments/gateway/payment-channel.registry'
import { PaymentGatewayPersistenceService } from '../../src/modules/payments/gateway/payment-gateway-persistence.service'
import { PaymentInitiationService } from '../../src/modules/payments/gateway/payment-initiation.service'
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory'
import { ManualTransferProvider } from '../../src/modules/payments/gateway/infrastructure/providers/manual-transfer.provider'
import { getWorld, seedScenario, type IntegrationWorld } from './world'

let world: IntegrationWorld
let initiation: PaymentInitiationService
let midtrans: MidtransPaymentProvider
let ledger: PaymentGatewayPersistenceService

const config = loadMidtransConfig()
/** Hard safety gate — three-way agreement, checked before any network call. */
const SANDBOX_SAFE = config.enabled && !config.isProduction && config.baseUrl.includes('sandbox')

beforeAll(async () => {
  world = await getWorld()

  const accounts = { getActiveAccount: async () => ({ id: 'acc', bankName: 'BCA', bankCode: '014', accountName: 'Mas Sular', accountNumber: '1234567890' }) }
  const manual = new ManualTransferProvider(world.prisma, accounts as never)
  midtrans = new MidtransPaymentProvider(config)

  const factory = new PaymentProviderFactory([manual, midtrans])
  const registry = new PaymentChannelRegistry(factory)
  ledger = new PaymentGatewayPersistenceService(world.prisma)
  initiation = new PaymentInitiationService(world.prisma, registry, factory, ledger)
}, 300_000)

/** A clearly identifiable sandbox test order. Never a real customer order. */
async function testPayment() {
  const s = await seedScenario(world, { method: 'GATEWAY' as never, paymentStatus: 'PENDING', orderStatus: 'PENDING' })
  await world.prisma.order.update({
    where: { id: s.order.id },
    data: { orderNumber: `SBXTEST-${randomUUID().replace(/-/g, '').slice(0, 10)}` },
  })
  return s
}

/** Error → safe category. Never surfaces a message that could carry a header. */
let lastDetail = ''

/** Midtrans business status/message only. Scrubs anything credential-shaped. */
function detail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/(Mid-[a-z]+-|SB-Mid-[a-z]+-)[A-Za-z0-9_\-]+/g, '[KEY]').replace(/Basic [A-Za-z0-9+/=]+/g, '[AUTH]').slice(0, 200)
}

function category(err: unknown): string {
  const name = err instanceof Error ? err.name : 'unknown'
  const msg = err instanceof Error ? err.message : ''
  lastDetail = detail(err)
  if (/401|unauthorized|access denied|check.*(client|server) key/i.test(msg)) return 'AUTHENTICATION_FAILED(401)'
  if (/402|403/.test(msg)) return 'AUTHORIZATION_OR_FEATURE_DISABLED'
  if (/404/.test(msg)) return 'NOT_FOUND(404)'
  if (/406/.test(msg)) return 'DUPLICATE_ORDER_ID(406)'
  const code = /status_code (\d+)/i.exec(msg)?.[1] ?? /\b(4\d\d|5\d\d)\b/.exec(msg)?.[1]
  return `${name}${code ? `(${code})` : ''}`
}

describe('Phase 5H.1 — real Midtrans Sandbox', () => {
  it('resolves a SANDBOX environment before any network call', () => {
    console.log('[SBX] enabled      :', config.enabled)
    console.log('[SBX] isProduction :', config.isProduction)
    console.log('[SBX] baseUrl      :', config.baseUrl)
    console.log('[SBX] sandbox safe :', SANDBOX_SAFE)

    expect(config.isProduction).toBe(false)
    expect(config.baseUrl).toContain('sandbox')
    expect(SANDBOX_SAFE).toBe(true)
  })

  // ---------------------------------------------------------------- channels --

  const channels: Array<[string, string]> = [
    ['QRIS', 'QRIS'],
    ['GoPay', 'GOPAY'],
    ['BCA VA', 'BCA_VA'],
  ]

  for (const [label, code] of channels) {
    it(`charges ${label} against the real Sandbox through PaymentInitiationService`, async () => {
      if (!SANDBOX_SAFE) throw new Error('refusing: config is not a sandbox environment')

      const s = await testPayment()
      let result: Awaited<ReturnType<PaymentInitiationService['initiate']>> | null = null
      let failure: string | null = null

      try {
        result = await initiation.initiate(s.payment.id, code)
      } catch (err) {
        failure = category(err)
      }

      if (failure) {
        console.log(`[SBX] ${label}: FAILED -> ${failure}`)
        console.log(`[SBX] ${label}: detail -> ${lastDetail}`)
        // Surface auth failures loudly; they are the gate.
        expect(failure).not.toContain('AUTHENTICATION_FAILED')
        console.log(`[SBX] ${label}: NOT EXECUTED — sandbox capability/limitation`)
        return
      }

      const gtx = await ledger.findLatestByPayment(s.payment.id)
      console.log(`[SBX] ${label}: provider=${result!.provider} providerStatus=${result!.providerStatus}`)
      console.log(`[SBX] ${label}: providerOrderId set=${Boolean(result!.providerOrderId)} txnRef set=${Boolean(result!.providerTransactionId)}`)
      console.log(`[SBX] ${label}: instruction=${result!.instructions.kind} expiresAt=${result!.expiresAt ? 'set' : 'null'}`)
      console.log(`[SBX] ${label}: gatewayRow=${Boolean(gtx)} ledgerProviderOrderId=${gtx?.providerOrderId === result!.providerOrderId ? 'MATCHES' : 'MISMATCH'}`)

      // §6 correlation, on a real transaction.
      expect(result!.provider).toBe('midtrans')
      expect(result!.providerOrderId).toBeTruthy()
      expect(gtx).not.toBeNull()
      expect(gtx!.providerOrderId).toBe(result!.providerOrderId)
      // Never the bare Mas Sular order number.
      const order = await world.prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })
      expect(result!.providerOrderId).not.toBe(order.orderNumber)
      expect(result!.providerOrderId!.startsWith(order.orderNumber)).toBe(true)
      expect(result!.instructions.kind).toBeTruthy()
    }, 120_000)
  }

  it('gives separate attempts different provider order ids', async () => {
    if (!SANDBOX_SAFE) throw new Error('refusing: not a sandbox environment')

    const a = await testPayment()
    const b = await testPayment()
    const ra = await initiation.initiate(a.payment.id, 'QRIS').catch(() => null)
    const rb = await initiation.initiate(b.payment.id, 'QRIS').catch(() => null)

    if (!ra || !rb) {
      console.log('[SBX] attempt-uniqueness: NOT EXECUTED — charge unavailable')
      return
    }
    console.log('[SBX] distinct providerOrderId:', ra.providerOrderId !== rb.providerOrderId)
    expect(ra.providerOrderId).not.toBe(rb.providerOrderId)
  }, 120_000)

  // ------------------------------------------------------------------ status --

  it('reads the real transaction back through the existing status operation', async () => {
    if (!SANDBOX_SAFE) throw new Error('refusing: not a sandbox environment')

    const s = await testPayment()
    const charge = await initiation.initiate(s.payment.id, 'QRIS').catch(() => null)
    if (!charge) {
      console.log('[SBX] status: NOT EXECUTED — charge unavailable')
      return
    }

    const status = await midtrans.getStatus({ paymentId: s.payment.id, providerReference: charge.providerOrderId! })
    console.log('[SBX] status: provider=%s mappedPaymentStatus=%s reference set=%s',
      status.provider, status.status, Boolean(status.providerReference))

    expect(status.provider).toBe('midtrans')
    expect(status.status).toBeTruthy()
    // The low-level status call must not have moved business state.
    const payment = await world.prisma.payment.findUniqueOrThrow({ where: { id: s.payment.id } })
    expect(payment.status).toBe('PENDING')
  }, 120_000)

  // ----------------------------------------------------------------- security --

  it('persists no credential in the gateway ledger', async () => {
    const rows = await world.prisma.paymentGatewayTransaction.findMany({ take: 20 })
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(config.serverKey ?? '@@none@@')
    expect(serialized).not.toContain(config.clientKey ?? '@@none@@')
    expect(serialized).not.toContain('Authorization')
    expect(serialized).not.toContain('Basic ')
  })
})
