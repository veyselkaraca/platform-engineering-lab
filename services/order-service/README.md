# order-service

Owns orders (PostgreSQL, database `order_service`) and publishes `order.created` to RabbitMQ. See [ADR-001](../../docs/decisions/ADR-001-stack-and-service-responsibilities.md) and the [order-notification feature](../../docs/features/order-notification/DESIGN.md).

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/orders` | `{userId, amount, description}` -> 201. Optional `Idempotency-Key` header: a repeated key returns the original order with 200 and publishes nothing. Unknown user -> 422; user lookup unavailable -> 503; validation -> 400 |
| GET | `/v1/orders/:id` | 200 / 404; non-UUID -> 400 |
| GET | `/health/live` | Process is up, no dependencies |
| GET | `/health/ready` | PostgreSQL reachable (2s timeout) |

AuthN/AuthZ (customer / owner / admin) is not implemented yet; it arrives with the Keycloak slice. Do not expose this service directly until then.

## Create-order flow

1. Replay check by `Idempotency-Key`.
2. User exists? Redis `user:{id}` (positive answers only, TTL) -> on miss `GET user-service /v1/users/{id}` with `x-request-id` forwarded, 2s timeout, one retry on network error or 5xx.
3. Insert order and idempotency key in one transaction; a concurrent duplicate key resolves to the winning order.
4. Publish `order.created` with broker confirms. If publishing fails the order is still returned (201) and `order.publish_failed` is logged with `orderId` and `correlationId`.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `REDIS_URL` | required | Cache only; outage degrades latency, not correctness |
| `RABBITMQ_URL` | required | Publisher; connects lazily and reconnects on the next publish |
| `USER_SERVICE_URL` | required | Base URL of user-service |
| `USER_LOOKUP_TIMEOUT_MS` | `2000` | Per-attempt timeout for user lookups |
| `USER_CACHE_TTL_SECONDS` | `60` | TTL for cached user existence |
| `PORT` | `3000` | Listen port |
| `LOG_LEVEL` | `info` | pino level |

Sample fake values: `.env.example`. Startup fails on missing or invalid values. Migrations run automatically at startup.

## Commands

```bash
npm ci
npm run lint
npm test
npm run build
```

Full stack (from the repo root): `sh scripts/bootstrap.sh`, then `docker compose -f infrastructure/docker/docker-compose.yml up -d --build`, then `sh scripts/smoke-test.sh http://localhost:3001 http://localhost:3002`. Debug in Docker with the dev overlay and the **order-service: attach (docker)** config (port 9230); see the user-service README.

## Operational notes

- **Why it exists / owns:** order records and the `order.created` event; nothing else writes to its database.
- **Depends on:** PostgreSQL (hard, readiness). user-service (needed to create orders; cached users still work while it is down). Redis and RabbitMQ are soft: neither is in readiness.
- **On failure:** PostgreSQL down -> readiness fails, traffic removed. user-service down -> 503 for uncached users. Redis down -> falls back to user-service, one warning logged per outage. RabbitMQ down -> order accepted, event lost and logged (ADR-001 limitation; a transactional outbox is the upgrade path).
- **Observed:** JSON logs (pino), `req.id` = `x-request-id` (reused or generated, echoed in the response, forwarded to user-service and used as the event `correlationId`); probe requests are not logged; `authorization`/`cookie` redacted. Metrics and traces arrive with the observability slice.
- **Image:** multi-stage, non-root, `HEALTHCHECK`, npm removed from the runtime stage, tag `order-service:<commit-sha>`.
- **CI:** `.github/workflows/order-service.yml` (shared `_service.yml`).
- **Rollback:** redeploy the previous image tag; migrations must stay backward compatible with the previous release.
- **Shutdown:** SIGTERM drains connections and closes the DB pool, Redis and the RabbitMQ connection.

## Dependency notes

NestJS is pinned to the 11 line (CommonJS); `amqplib` 2.x ships its own types; `multer` is overridden to a patched release (see the user-service README).
