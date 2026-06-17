# Integration / E2E suite (Phase 10D)

End-to-end validation of the order + payment + async pipeline against **real
infrastructure** — no mocks for Prisma, RabbitMQ channels, the relay, or the
consumers. MySQL 8 and RabbitMQ are provisioned per run via
[Testcontainers](https://testcontainers.com/).

## Requirements

- **A running Docker daemon.** Testcontainers launches `mysql:8.4` and
  `rabbitmq:3.13-management` containers; without Docker the suite cannot start.
- Network access to pull those images on first run.

## Run

```bash
pnpm test:integration
# (= jest --config test/integration/jest.integration.config.js)
```

On startup the harness (`world.ts`):

1. Starts the MySQL + RabbitMQ containers and points `DATABASE_URL` /
   `RABBITMQ_URL` at them.
2. Applies every migration with `prisma migrate deploy`.
3. Constructs the **real** services (PrismaService, RabbitConnectionManager,
   OutboxRelayWorker, the two notification consumers, PaymentLifecycleWorker,
   AdminService, PaymentsService) and starts the consumers so their queues are
   bound before any publish.

Containers are reaped by Testcontainers' Ryuk when the process exits.

## Scenarios

| File | Scenario |
| --- | --- |
| `checkout-flow.int-spec.ts` | B — checkout persists order/payment/outbox → relay publishes → consumer enqueues notification |
| `payment-upload.int-spec.ts` | C — tokenized receipt submit → `WAITING_VERIFICATION` + `payment.receipt_uploaded` once |
| `payment-verify.int-spec.ts` | D — verify → `PAID` + order `PROCESSING` + `payment.paid` once + notification; replay no-op |
| `payment-reject.int-spec.ts` | E — reject → `FAILED` + order `CANCELLED` + stock restored + `payment.failed` once |
| `reminder.int-spec.ts` | F — reminder emitted once + notification; re-run no duplicate |
| `expiry.int-spec.ts` | G — expiry → `EXPIRED` + order `CANCELLED` + stock restored + `payment.expired` once; re-run no duplicate |
| `relay-recovery.int-spec.ts` | H — publish-before-markPublished → relay reclaims + republishes → consumer dedup → single effect |
| `consumer-redelivery.int-spec.ts` | I — redelivered message → ProcessedEvent dedup → no duplicate NotificationOutbox |

## Exactly-once guarantees exercised

- **Relay at-least-once + mark-after-confirm** (B, H): a row is `PUBLISHED` only
  after the broker confirm; an unmarked row is reclaimed and republished.
- **Consumer dedup** via `ProcessedEvent (consumer, messageId)` written in the
  same transaction as the `NotificationOutbox` insert (H, I).
- **Per-row CAS terminal transitions** for verify/reject/expiry/reminder
  (D, E, F, G): a replay flips zero rows, so no duplicate event/effect.
- **Single-use upload token** CAS (C).
