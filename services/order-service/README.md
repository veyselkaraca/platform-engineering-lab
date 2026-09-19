# order-service

Owns orders (PostgreSQL, database `order_service`) and publishes `order.created` to RabbitMQ. See [ADR-001](../../docs/decisions/ADR-001-stack-and-service-responsibilities.md) and the [order-notification feature](../../docs/features/order-notification/DESIGN.md).

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/orders` | `{userId, amount, description}` -> 201. Optional `Idempotency-Key` header: a repeated key returns the original order with 200 and publishes nothing. Unknown user -> 422; user lookup unavailable -> 503; validation -> 400. **Role `customer` for themself (`userId` = token `sub`), or `admin` for any user;** ordering for someone else -> 403. A key already used by a different user -> 409 (never that user's order) |
| GET | `/v1/orders/:id` | **Owner or admin.** 200 / 404; a non-owner gets the same 404 as for a missing order; non-UUID -> 400 |
| GET | `/health/live` | Process is up, no dependencies |
| GET | `/health/ready` | PostgreSQL reachable (2s timeout) |

All `/v1` routes need a valid Keycloak bearer token (`401` otherwise). Roles and ownership are enforced here, not only at the gateway. See [identity-keycloak](../../docs/features/identity-keycloak/DESIGN.md); the verifier is in `src/auth/`. Without Keycloak's keys the service answers `503` (fail closed) but stays live and ready.

## Create-order flow

1. Replay check by `Idempotency-Key` (a key that belongs to another user is a 409).
2. User exists? Redis `user:{id}` (positive answers only, TTL) -> on miss `GET user-service /v1/users/{id}` with `x-request-id` and the caller's own `Authorization` header forwarded (user-service authorizes the lookup for the caller; no service-to-service credential), 2s timeout, one retry on network error or 5xx.
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

Full stack (from the repo root): `sh scripts/bootstrap.sh`, then `docker compose -f infrastructure/docker/docker-compose.yml up -d --build`, then `sh scripts/smoke-test.sh http://localhost:3001 http://localhost:3002` (needs Keycloak for tokens). Debug in Docker with the dev overlay and the **order-service: attach (docker)** config (port 9230); see the user-service README.

## Operational notes

- **Why it exists / owns:** order records and the `order.created` event; nothing else writes to its database.
- **Depends on:** PostgreSQL (hard, readiness). user-service (needed to create orders; cached users still work while it is down). Redis, RabbitMQ and Keycloak's public keys are soft: none is in readiness.
- **On failure:** PostgreSQL down -> readiness fails, traffic removed, requests get a generic `503` (`database.unavailable` logged with the request id). user-service down -> 503 for uncached users. Redis down -> falls back to user-service, one warning logged per outage. RabbitMQ down -> order accepted, event lost and logged (ADR-001 limitation; a transactional outbox is the upgrade path).
- **Verified:** Redis and user-service outages against the real stack in `tests/chaos/dependency-failures.chaos.mjs` (fallback, fail-fast `503`, one warning per Redis outage, recovery without restart); broker-down-at-publish in `tests/chaos/broker-failures.chaos.mjs`.
- **Observed:** JSON logs (pino), `req.id` = `x-request-id` (reused or generated, echoed in the response, forwarded to user-service and used as the event `correlationId`); probe requests are not logged; `authorization`/`cookie` redacted. Metrics and traces arrive with the observability slice.
- **Image:** multi-stage, non-root, `HEALTHCHECK`, npm removed from the runtime stage, tag `order-service:<commit-sha>`.
- **CI:** `.github/workflows/order-service.yml` (shared `_service.yml`).
- **Rollback:** redeploy the previous image tag; migrations must stay backward compatible with the previous release.
- **Shutdown:** SIGTERM drains connections and closes the DB pool, Redis and the RabbitMQ connection.

## Dependency notes

NestJS is pinned to the 11 line (CommonJS); `amqplib` 2.x ships its own types; `multer` is overridden to a patched release (see the user-service README).
