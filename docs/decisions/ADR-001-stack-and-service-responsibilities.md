# ADR-001: Stack and service responsibilities

- Status: Accepted
- Scope: Implementation decision under AGENTS.md §9 (technology baseline). Does not change the charter.

## Context

AGENTS.md fixes technology *families* (NestJS, PostgreSQL, Redis, RabbitMQ, Keycloak, Kubernetes/Helm, Ansible) and requires the smallest architecture that demonstrates the platform lifecycle (§7.12, §30). Concrete service boundaries and integration contracts are left open.

## Decision

**Services** (all Node.js LTS + TypeScript + NestJS, REST, one repo directory and one image each):

| Service | Owns | Talks to |
|---|---|---|
| `api-gateway` | Single entry point, JWT verification, routing, rate limiting, request-id creation | user-service, order-service (sync HTTP) |
| `user-service` | User records (PostgreSQL) | PostgreSQL |
| `order-service` | Order records (PostgreSQL); publishes `order.created`; caches user lookups | user-service (sync HTTP), Redis, RabbitMQ (publish), PostgreSQL |
| `notification-worker` | Consumes `order.created`; records a (simulated) notification | RabbitMQ (consume), PostgreSQL |

**Data**
- One PostgreSQL instance, **one database per service** — no cross-service table access (§7.9).
- Redis is a cache only, never authoritative (§21). Cached: user lookups in order-service, TTL-bound, with fallback to user-service when Redis is down.

**Messaging**
- Topic exchange `orders`, routing key `order.created`, durable queue `notification.order-created`.
- Retry through a TTL retry queue with a bounded attempt count, then a dead-letter queue (§17, §20).
- Consumers are idempotent, keyed on the event id. Every message carries `eventId`, `correlationId`, `occurredAt`.

**Identity**
- Keycloak realm `platform-lab`, OIDC/OAuth2. Roles: `customer`, `admin`.
- Gateway verifies the JWT at the edge; each service also verifies the token and enforces role rules itself (no implicit trust of the network).

**Cross-cutting**
- API prefix `/v1`. Health endpoints `/health/live` and `/health/ready` on every service.
- `x-request-id` on every request/message plus W3C `traceparent` (OpenTelemetry).
- Config from environment variables only; secrets are runtime inputs (§24).
- Notifications are **simulated** (persisted + logged). No real email/SMS provider — that would add an external dependency with no platform value.

## Consequences

- Two sync hops (gateway → service, order → user) and one async hop give a realistic trace across services with minimal domain code.
- Database-per-service costs a bit more setup but keeps coupling explicit.
- Known limitation: order-service publishes after the DB commit, so a crash between commit and publish can lose an event. A transactional outbox is the upgrade path and needs its own ADR when the failure scenario is demonstrated.

## Alternatives considered

- **Shared database / schema-per-service:** simpler, but hides coupling; rejected.
- **Transactional outbox from day one:** correct but adds a relay component before the basic flow works; deferred.
- **Real email provider in the worker:** rejected, see above.
