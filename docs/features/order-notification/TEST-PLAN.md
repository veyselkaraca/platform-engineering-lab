# Feature: order-notification — Test Plan

Layers follow AGENTS.md §12.5. Failure scenarios follow §28: for each, record what failed, how it was detected, the evidence, the automated behavior, any operator action, and how recovery is verified.

## Layers

| Layer | Covers |
|---|---|
| Unit | Validation, idempotency-key logic, cache fallback, retry-count logic, role/ownership rules |
| Integration (`tests/integration`) | Each service against real PostgreSQL/Redis/RabbitMQ (containers): migrations, unique constraints, publish/consume, DLQ routing |
| Contract (`tests/contract`) | order-service ↔ user-service HTTP, and the `order.created` event schema |
| E2E (`tests/e2e`) | Token from Keycloak → gateway → order → notification stored; one trace id across services |
| Smoke (`scripts/smoke-test.sh`) | Post-deploy: health endpoints, one create-order round trip |
| Chaos (`tests/chaos`) | Scenarios below |

## Requirement traceability

| Req | Verified by |
|---|---|
| FR-1..4 | Unit + integration + e2e |
| FR-5, FR-6 | Integration + e2e |
| FR-7 | Integration: publish same `eventId` twice → one row |
| FR-8 | Integration: poison message → retries → DLQ; healthy message behind it is processed |
| FR-9 | Unit + integration: same key twice → one order |
| NFR-2 | E2E: trace/request id present in every service's logs |
| NFR-4 | Chaos: Redis down |
| NFR-6 | Integration: SIGTERM during in-flight message |

## Failure scenarios

| Scenario | Expected behavior | Detection |
|---|---|---|
| Redis down | Order still created; latency up; fallback to user-service | Cache error metric, log |
| user-service down | order-service returns 503, no order stored | Readiness/error-rate alert |
| PostgreSQL down (any service) | Readiness fails, traffic removed, 503 | Readiness probe, alert |
| RabbitMQ down at publish | Order stored, publish failure logged/counted | Publish-failure metric, alert |
| RabbitMQ down in worker | Worker reconnects; no message loss for already-queued messages | Connection metric, queue depth |
| Poison message | Retried N times, lands in DLQ, others unaffected | DLQ depth alert |
| Duplicate delivery | One notification | Unique constraint, dedupe counter |
| Invalid/expired token | 401 at gateway; no downstream call | `auth.rejected` log now, auth failure metric with observability. Full auth matrix and Keycloak outage scenarios: [identity-keycloak TEST-PLAN](../identity-keycloak/TEST-PLAN.md) |
| Wrong role / other user's order | 403 | Log with request id |
| Bad configuration | Service fails startup, does not become ready | Startup probe |
| Failed deployment | Rollout halts on failed readiness; `helm rollback` restores previous image | Rollout status, smoke test |
