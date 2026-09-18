# notification-worker

Consumes `order.created` from RabbitMQ and records one (simulated) notification per event in PostgreSQL (database `notification_worker`). See [ADR-001](../../docs/decisions/ADR-001-stack-and-service-responsibilities.md) and the [order-notification feature](../../docs/features/order-notification/DESIGN.md).

## HTTP surface

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/notifications?orderId=<uuid>` | Notifications recorded for an order; used by operators and the smoke test to confirm the async path. Non-UUID or missing -> 400 |
| GET | `/health/live` | Process is up, no dependencies (a broker outage never restarts the pod) |
| GET | `/health/ready` | PostgreSQL reachable **and** the RabbitMQ consumer is connected; a worker that is not consuming is not functional |

AuthN/AuthZ arrives with the Keycloak slice; do not expose this service directly until then.

## Message handling

```text
delivery -> parse/validate -> INSERT ... ON CONFLICT (event_id) DO NOTHING -> ack

malformed message ............ dead-letter immediately (retrying cannot help)
transient failure (e.g. DB) .. nack -> retry queue (10s TTL) -> main queue, up to MAX_ATTEMPTS
attempts exhausted ........... publish to DLQ with reason + attempt headers (confirmed), then ack
DLQ publish fails ............ nack to the retry path instead of losing the message
```

- **Idempotent (FR-7):** `UNIQUE(event_id)`; a redelivered event is acknowledged without a second notification.
- **Attempt counting:** derived from RabbitMQ's `x-death` header (rejections from the main queue), so the count survives worker restarts and needs no extra state.
- **Backpressure:** `WORKER_PREFETCH` bounds unacknowledged messages in flight.
- **Broker outages:** the worker reconnects with capped backoff (1s to 10s) and reports not-ready meanwhile; it also reconnects if the queue or channel is closed.
- **Shutdown (SIGTERM):** cancels the consumer, waits up to 10s for in-flight messages, then closes the connection; the DB pool closes after that.

Recovering dead-lettered messages: [runbook](../../docs/operations/runbooks/notification-dlq.md) and `scripts/replay-dlq.sh`.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `RABBITMQ_URL` | required | Broker; the queues are declared by `messaging/rabbitmq/definitions`, not by this service |
| `WORKER_PREFETCH` | `10` | Max unacknowledged messages in flight |
| `MAX_ATTEMPTS` | `3` | Total processing attempts before dead-lettering |
| `PORT` | `3000` | Health/HTTP listen port |
| `LOG_LEVEL` | `info` | pino level |

Sample fake values: `.env.example`. Startup fails on missing or invalid values. Migrations run automatically at startup.

## Commands

```bash
npm ci
npm run lint
npm test
npm run build
```

Full stack (from the repo root): `sh scripts/bootstrap.sh`, `docker compose -f infrastructure/docker/docker-compose.yml up -d --build`, then `sh scripts/smoke-test.sh http://localhost:3001 http://localhost:3002 http://localhost:3003`. Debug in Docker with the dev overlay and **notification-worker: attach (docker)** (port 9231).

## Operational notes

- **Why it exists / owns:** asynchronous notification handling; nothing else writes to its database.
- **Depends on:** PostgreSQL and RabbitMQ (both hard for readiness).
- **On failure:** DB down -> readiness fails, messages retry and then dead-letter after `MAX_ATTEMPTS`. Broker down -> readiness fails, worker reconnects by itself. Poison message -> DLQ, other messages unaffected.
- **Observed:** JSON logs with `notification.sent`, `notification.duplicate_ignored`, `notification.retry`, `notification.dead_lettered` lines carrying `eventId`/`messageId` and `correlationId` (the originating `x-request-id`). Metrics (processed/failed/dead-lettered counts, queue depth) arrive with the observability slice.
- **Image:** multi-stage, non-root, `HEALTHCHECK`, npm removed from the runtime stage, tag `notification-worker:<commit-sha>`.
- **CI:** `.github/workflows/notification-worker.yml` (shared `_service.yml`); the smoke test creates an order and waits for its notification.
- **Rollback:** redeploy the previous image tag; migrations must stay backward compatible with the previous release. In-flight messages are not lost: unacknowledged deliveries return to the queue.

## Dependency notes

NestJS is pinned to the 11 line (CommonJS); `amqplib` 2.x ships its own types; `multer` is overridden to a patched release (see the user-service README).
