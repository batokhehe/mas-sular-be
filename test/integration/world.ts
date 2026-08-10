/**
 * Integration "world": real MySQL + RabbitMQ via Testcontainers, real Prisma,
 * real RabbitConnectionManager, and the real relay / consumers / lifecycle worker
 * (NO mocks). Constructed once (singleton) and shared across the integration specs
 * (jest runs them with maxWorkers=1). Containers are reaped by Testcontainers' Ryuk
 * when the process exits.
 *
 * REQUIRES A RUNNING DOCKER DAEMON — these specs cannot run without it.
 */
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql'
import { RabbitMQContainer, StartedRabbitMQContainer } from '@testcontainers/rabbitmq'
import type { Order, Payment } from '@prisma/client'

import { PrismaService } from '../../src/database/prisma.service'
import { RabbitConnectionManager } from '../../src/infrastructure/outbox/rabbit-connection.manager'
import { loadOutboxConfig, OutboxRelayConfig } from '../../src/infrastructure/outbox/outbox.config'
import { OutboxRelayWorker } from '../../src/infrastructure/outbox/outbox-relay.worker'
import { MetricsRegistry } from '../../src/infrastructure/metrics/metrics.registry'
import { RelayMetrics } from '../../src/infrastructure/metrics/relay.metrics'
import { NotificationMetrics } from '../../src/infrastructure/notifications/notification.metrics'
import { OrderCreatedNotificationConsumer } from '../../src/infrastructure/consumers/order-created-notification.consumer'
import { PaymentNotificationConsumer } from '../../src/infrastructure/consumers/payment-notification.consumer'
import { loadConsumersConfig, ConsumersConfig } from '../../src/infrastructure/consumers/consumers.config'
import { PaymentLifecycleWorker } from '../../src/modules/payments/payment-lifecycle.worker'
import { PaymentLifecycleMetrics } from '../../src/modules/payments/payment-lifecycle.metrics'
import { loadPaymentLifecycleConfig } from '../../src/modules/payments/payment-lifecycle.config'
import { PaymentUploadTokenService } from '../../src/modules/payments/payment-upload-token.service'
import { OrderCancellationService } from '../../src/modules/orders/order-cancellation.service'
import { AdminService } from '../../src/modules/admin/admin.service'
import { PaymentsService } from '../../src/modules/payments/payments.service'

export interface IntegrationWorld {
  prisma: PrismaService
  rabbit: RabbitConnectionManager
  relay: OutboxRelayWorker
  orderConsumer: OrderCreatedNotificationConsumer
  paymentConsumer: PaymentNotificationConsumer
  lifecycle: PaymentLifecycleWorker
  uploadTokens: PaymentUploadTokenService
  cancellation: OrderCancellationService
  admin: AdminService
  payments: PaymentsService
  mysql: StartedMySqlContainer
  rabbitmq: StartedRabbitMQContainer
}

let worldPromise: Promise<IntegrationWorld> | null = null

export function getWorld(): Promise<IntegrationWorld> {
  if (!worldPromise) worldPromise = boot()
  return worldPromise
}

async function boot(): Promise<IntegrationWorld> {
  const mysql = await new MySqlContainer('mysql:8.4')
    .withDatabase('app')
    .withUsername('app')
    .withUserPassword('app')
    .start()
  const rabbitmq = await new RabbitMQContainer('rabbitmq:3.13-management').start()

  const databaseUrl = mysql.getConnectionUri()
  const amqpUrl = rabbitmq.getAmqpUrl()
  process.env.DATABASE_URL = databaseUrl
  process.env.RABBITMQ_URL = amqpUrl

  // Apply every migration to the fresh database.
  execSync('npx prisma migrate deploy', {
    cwd: join(__dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  })

  const prisma = new PrismaService()
  await prisma.$connect()

  const registry = new MetricsRegistry()
  const outboxConfig: OutboxRelayConfig = { ...loadOutboxConfig(), enabled: true, rabbitmqUrl: amqpUrl }
  const rabbit = new RabbitConnectionManager(outboxConfig)
  const relay = new OutboxRelayWorker(prisma, rabbit, new RelayMetrics(registry), outboxConfig)

  const consumersConfig: ConsumersConfig = {
    ...loadConsumersConfig(),
    enabled: true,
    rabbitmqUrl: amqpUrl,
    adminNotificationEmail: 'ops@masular.test',
  }
  const notifMetrics = new NotificationMetrics(registry)
  const orderConsumer = new OrderCreatedNotificationConsumer(prisma, rabbit, notifMetrics, consumersConfig)
  const paymentConsumer = new PaymentNotificationConsumer(prisma, rabbit, notifMetrics, consumersConfig)

  const uploadTokens = new PaymentUploadTokenService(prisma)
  const cancellation = new OrderCancellationService()
  const lifecycle = new PaymentLifecycleWorker(
    prisma,
    uploadTokens,
    cancellation,
    new PaymentLifecycleMetrics(registry),
    // Timing windows are PINNED, not inherited. Prisma Client injects the
    // developer's .env into process.env when it loads, so `loadPaymentLifecycleConfig()`
    // would pick up whatever PAYMENT_EXPIRY_MS / PAYMENT_*_REMINDER_MS that file
    // happens to set (Phase 5H.1 §8/§11 root cause: 72h/24h there vs the 24h/12h
    // these specs are written against). Pinning keeps the suite deterministic on any
    // machine; it changes no production default.
    {
      ...loadPaymentLifecycleConfig(),
      enabled: true,
      expiryAfterMs: 24 * 60 * 60 * 1000,
      gatewayExpiryAfterMs: 24 * 60 * 60 * 1000,
      firstReminderAfterMs: 12 * 60 * 60 * 1000,
      secondReminderAfterMs: 20 * 60 * 60 * 1000,
    },
  )
  const admin = new AdminService(prisma, cancellation)
  const payments = new PaymentsService(prisma, uploadTokens)

  // Start consumers so their queues are declared/bound BEFORE any publish.
  await orderConsumer.onApplicationBootstrap()
  await paymentConsumer.onApplicationBootstrap()

  return {
    prisma,
    rabbit,
    relay,
    orderConsumer,
    paymentConsumer,
    lifecycle,
    uploadTokens,
    cancellation,
    admin,
    payments,
    mysql,
    rabbitmq,
  }
}

// ---------------- helpers ----------------

export async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 20_000, intervalMs = 250 } = {},
): Promise<void> {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met within timeout')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export interface SeedOptions {
  method?: 'BANK_TRANSFER' | 'QRIS' | 'COD'
  paymentStatus?: 'PENDING' | 'WAITING_VERIFICATION' | 'PAID' | 'FAILED' | 'EXPIRED'
  orderStatus?: 'PENDING' | 'PROCESSING'
  stock?: number
  paymentCreatedAt?: Date
}

export interface SeededScenario {
  uid: string
  productId: string
  userId: string
  email: string
  order: Order & { payment: Payment | null }
  payment: Payment
}

/** Create a category+product+user+address+order(+item)+payment via real Prisma. */
export async function seedScenario(world: IntegrationWorld, opts: SeedOptions = {}): Promise<SeededScenario> {
  const { prisma } = world
  const uid = randomUUID().slice(0, 8)
  const method = opts.method ?? 'BANK_TRANSFER'
  const stock = opts.stock ?? 10

  const category = await prisma.category.create({ data: { name: `Cat ${uid}`, slug: `cat-${uid}` } })
  const product = await prisma.product.create({
    data: { slug: `p-${uid}`, sku: `sku-${uid}`, name: 'Bakso', description: 'x', price: 30000, imageUrl: '/x.png', stock, categoryId: category.id },
  })
  const email = `u-${uid}@test.local`
  const user = await prisma.user.create({ data: { email, name: 'Jane' } })
  const address = await prisma.address.create({
    data: { userId: user.id, label: 'Home', recipientName: 'Jane', phone: '0812345678', fullAddress: 'Jl Test 1', latitude: 0, longitude: 0 },
  })

  const order = await prisma.order.create({
    data: {
      orderNumber: `BMS-${uid}`,
      userId: user.id,
      addressId: address.id,
      status: opts.orderStatus ?? 'PROCESSING',
      subtotal: 30000,
      deliveryFee: 10000,
      totalPrice: 40000,
      paymentMethod: method,
      items: { create: { productId: product.id, productName: product.name, unitPrice: 30000, quantity: 1 } },
      payment: {
        create: {
          method,
          amount: 40000,
          status: opts.paymentStatus ?? 'WAITING_VERIFICATION',
          ...(opts.paymentCreatedAt ? { createdAt: opts.paymentCreatedAt } : {}),
        },
      },
    },
    include: { payment: true, items: true },
  })

  return { uid, productId: product.id, userId: user.id, email, order, payment: order.payment! }
}

/** Mirror the checkout write (order+payment+outbox order.created) in ONE real transaction. */
export async function checkout(world: IntegrationWorld): Promise<{ scenario: SeededScenario; outboxId: string }> {
  const scenario = await seedScenario(world, { orderStatus: 'PENDING', paymentStatus: 'PENDING' })
  const event = await world.prisma.outboxEvent.create({
    data: {
      aggregateType: 'order',
      aggregateId: scenario.order.id,
      eventName: 'order.created',
      exchange: 'orders',
      routingKey: 'order.created',
      payload: { orderId: scenario.order.id, orderNumber: scenario.order.orderNumber, totalPrice: scenario.order.totalPrice },
      occurredAt: new Date(),
    },
  })
  return { scenario, outboxId: event.id }
}

export const HOUR = 60 * 60 * 1000
