# Feature: order-notification — Design

Implements [REQUIREMENTS.md](REQUIREMENTS.md) within the boundaries of [ADR-001](../../decisions/ADR-001-stack-and-service-responsibilities.md).

## Order creation sequence

1. Gateway verifies the JWT, assigns `x-request-id` if absent, routes to order-service.
2. order-service verifies the token, checks the `customer` role and that `userId` matches the caller (unless `admin`).
3. If `Idempotency-Key` was seen before → return the stored order (200).
4. User lookup: Redis `user:{id}` → miss → `GET user-service /v1/users/{id}` (timeout 2s, 1 retry) → cache with TTL. 404 → 422 to client; timeout/5xx → 503.
5. Insert order (and idempotency key) in one DB transaction.
6. Publish `order.created` with publisher confirms. On publish failure: log at error level (`order.publish_failed` with `orderId` and `correlationId`), still return 201 (see ADR-001 known limitation). The failure counter metric arrives with the observability slice.
7. Return 201.

## Data

| Service | Table | Notes |
|---|---|---|
| user-service | `users(id, email UNIQUE, name, created_at)` | |
| order-service | `orders(id, user_id, amount, description, status, created_at)` | `status` starts as `CREATED` |
| order-service | `idempotency_keys(key PRIMARY KEY, order_id, created_at)` | |
| notification-worker | `notifications(id, event_id UNIQUE, order_id, user_id, created_at)` | `UNIQUE(event_id)` enforces FR-7 |

Schema changes are versioned migrations run by the service at deploy time, not manual SQL.

## Messaging topology

```text
exchange orders (topic, durable)
   └─ order.created ─▶ queue notification.order-created (durable)
                          │ nack after failure
                          ▼
                    notification.order-created.retry  (TTL, dead-letters back to main queue)
                          │ attempts > MAX
                          ▼
                    notification.order-created.dlq
```

Attempts are counted from RabbitMQ's own `x-death` header (rejections from the main queue), so the count survives worker restarts. A malformed message is dead-lettered immediately (retrying cannot help); a transient failure is retried up to `MAX_ATTEMPTS`, then dead-lettered with `x-failure-reason` and `x-failed-attempts` headers. The worker uses a bounded prefetch for backpressure (§17). Dead-lettered messages are recovered with `scripts/replay-dlq.sh` (see `docs/operations/runbooks/notification-dlq.md`). Definitions live in `messaging/rabbitmq/definitions/` and are imported declaratively (locally by the `rabbitmq-init` service; see `messaging/rabbitmq/README.md`).

## Cache

- Key `user:{id}`, TTL-bound, value is the minimal user projection.
- No write-through from user-service; consistency is "eventually consistent within the TTL". Stale data is acceptable because orders only need existence and id.

## Auth

- Realm `platform-lab`, roles `customer` and `admin`, one client per API audience.
- Ownership is checked from the token `sub` claim mapped to `userId`.
- Exact claim mapping is documented in `security/keycloak/README.md` when the realm is defined.

## Configuration (environment variables, per service)

Database URL, Redis URL, RabbitMQ URL, Keycloak issuer/JWKS URL, downstream base URLs, timeouts, cache TTL, retry limits, OTLP endpoint. No defaults for secrets; sample values in `.env.example` are clearly fake.

## Deployment and rollback

Each service is a separate Deployment with readiness/liveness/startup probes, resource requests/limits, and rolling updates. Rollback is `helm rollback` to the previous release using the already-published image tag. Migrations must be backward compatible with the previous release (expand/contract) so rollback stays safe.
