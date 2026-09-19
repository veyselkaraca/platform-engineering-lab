# notification-worker

Consumes `order.created` from RabbitMQ and records one (simulated) notification per event in PostgreSQL (database `notification_worker`). See [ADR-001](../../docs/decisions/ADR-001-stack-and-service-responsibilities.md) and the [order-notification feature](../../docs/features/order-notification/DESIGN.md).

## HTTP surface

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/notifications?orderId=<uuid>` | Notifications recorded for an order; used to confirm the async path. **Customers see only their own** (someone else's order looks like an order without notifications: `[]`); admins see all. Non-UUID or missing -> 400 |
| GET | `/health/live` | Process is up, no dependencies (a broker outage never restarts the pod) |
| GET | `/health/ready` | PostgreSQL reachable **and** the RabbitMQ consumer is connected; a worker that is not consuming is not functional |

`/v1` needs a valid Keycloak bearer token (`401` otherwise, `403` without the `customer` or `admin` role); see [identity-keycloak](../../docs/features/identity-keycloak/DESIGN.md), verifier in `src/auth/`. Without Keycloak's keys it answers `503` (fail closed); the consumer keeps running and readiness is unaffected.

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

How this behaviour is verified against the real broker and database: `tests/integration/notification-consumer.test.mjs` (idempotency, poison messages, not blocked), `tests/contract/order-created-event.test.mjs` (event schema) and `tests/chaos/broker-failures.chaos.mjs` (retry, dead-lettering, replay, broker restarts, graceful SIGTERM).

Recovering dead-lettered messages: [runbook](../../docs/operations/runbooks/notification-dlq.md) and `scripts/replay-dlq.sh`.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `RABBITMQ_URL` | required | Broker; the queues are declared by `messaging/rabbitmq/definitions`, not by this service |
| `WORKER_PREFETCH` | `10` | Max unacknowledged messages in flight |
| `MAX_ATTEMPTS` | `3` | Total processing attempts before dead-lettering |
| `PORT` | `3000` | Health/HTTP listen port |
| `AUTH_ISSUER` | required | Expected token `iss` (Keycloak realm URL as clients see it) |
| `AUTH_AUDIENCE` | required | Required token `aud` (`platform-api`) |
| `AUTH_JWKS_URL` | required | Where Keycloak's public signing keys are fetched from |
| `AUTH_JWKS_TIMEOUT_MS` | `2000` | Timeout of the key fetch |
| `AUTH_JWKS_CACHE_SECONDS` | `3600` | How long fetched keys are trusted; after that (with Keycloak down) requests get 503 |
| `AUTH_CLOCK_TOLERANCE_SECONDS` | `5` | Accepted clock skew, max 60 |
| `LOG_LEVEL` | `info` | pino level |

Sample fake values: `.env.example`. Startup fails on missing or invalid values. Migrations run automatically at startup.

## Commands

```bash
npm ci
npm run lint
npm test
npm run build
```

Full stack (from the repo root): `sh scripts/bootstrap.sh`, `docker compose -f infrastructure/docker/docker-compose.yml up -d --build`, then `sh scripts/smoke-test.sh http://localhost:3001 http://localhost:3002 http://localhost:3003` (needs Keycloak for tokens). Debug in Docker with the dev overlay and **notification-worker: attach (docker)** (port 9231).

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
