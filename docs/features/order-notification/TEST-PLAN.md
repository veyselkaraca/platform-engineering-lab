# Feature: order-notification — Test Plan

Layers follow the [engineering standards](../../architecture/engineering-standards.md#development-standards). Failure scenarios follow [Failure and recovery](../../architecture/engineering-standards.md#failure-and-recovery): for each, record what failed, how it was detected, the evidence, the automated behavior, any operator action, and how recovery is verified.

## Layers

| Layer | Covers |
|---|---|
| Unit | Validation, idempotency-key logic, cache fallback, retry-count logic, role/ownership rules |
| Integration (`tests/integration`) | Each service against real PostgreSQL/Redis/RabbitMQ (containers): migrations, unique constraints, publish/consume, DLQ routing |
| Contract (`tests/contract`) | order-service ↔ user-service HTTP (`order-user-lookup.test.mjs`), and the `order.created` event schema as really published (`order-created-event.test.mjs`) |
| E2E (`tests/e2e`) | Token from Keycloak → gateway → order → notification stored; one trace id across services |
| Smoke (`scripts/smoke-test.sh`) | Post-deploy: health endpoints, one create-order round trip |
| Chaos (`tests/chaos`) | Scenarios below: `broker-failures.chaos.mjs` (async path, DB and broker outages, graceful stop), `dependency-failures.chaos.mjs` (Redis and user-service outages), `database-failures.chaos.mjs` (PostgreSQL outage) and `keycloak-outage.sh` |

## Requirement traceability

| Req | Verified by |
|---|---|
| FR-1..4 | Unit + integration + e2e |
| FR-5, FR-6 | Integration + e2e |
| FR-7 | Integration: publish same `eventId` twice → one row |
| FR-8 | Integration: poison message → retries → DLQ; healthy message behind it is processed |
| FR-9 | Unit + integration: same key twice → one order |
| NFR-2 | E2E: trace/request id present in every service's logs. Verified against real telemetry by `tests/observability/pipeline.obs.mjs`: one order is one trace over all four services and every service's log lines for it carry the trace id |
| NFR-7 | `tests/observability/pipeline.obs.mjs` (metrics present per service, worker outcomes, queue depth from the broker) and the alerts in [observability](../observability/TEST-PLAN.md) |
| NFR-4 | Chaos: Redis down (`dependency-failures.chaos.mjs`) |
| NFR-6 | Integration: SIGTERM during in-flight message |

## Failure scenarios

| Scenario | Expected behavior | Detection |
|---|---|---|
| Redis down | Order still created; fallback to user-service, one warning line per outage | Cache error metric, log (`Redis unavailable`, `Redis connection restored`) |
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

## Results (as built, 2026-09-19)

Run with the stack up: `node --test --test-concurrency=1 "tests/**/*.test.mjs"` (integration, contract, e2e; 64 tests) and, on purpose because it is disruptive, `node --test --test-concurrency=1 tests/chaos/broker-failures.chaos.mjs tests/chaos/dependency-failures.chaos.mjs tests/chaos/database-failures.chaos.mjs` (10 scenarios, about four minutes). Broker access is through RabbitMQ's management API, so the tests need nothing installed.

| Requirement / scenario | Verified by | Result |
|---|---|---|
| FR-5 event content | `contract/order-created-event.test.mjs`: envelope, persistent delivery, `message_id == eventId`, request id becomes `correlationId`, amount/user/order in `data`; one event per order, none for an idempotent replay or a rejected order | pass |
| FR-6, FR-7 | `integration/notification-consumer.test.mjs`: valid event stored; the same event delivered three times gives one row | pass |
| FR-8 poison message | Same file: five kinds of malformed message dead-lettered at once with `x-failure-reason` and `x-failed-attempts`, never enter the retry queue, correlation id preserved, the valid message behind them is processed | pass |
| FR-8 retries | Chaos: with PostgreSQL down the message is retried (`notification.retry ... attempt=1/3`), and processed once the database is back; a failure that outlasts the budget is dead-lettered with `gave up after 3 attempts` and 3 recorded attempts | pass |
| DLQ runbook | Chaos: `scripts/replay-dlq.sh` moves the dead-lettered message back and the notification is created | pass |
| RabbitMQ down in worker | Chaos: persistent messages survive a broker restart while the worker is down and are processed after; with the worker running it turns not-ready, reconnects by itself and consumes again | pass |
| RabbitMQ down at publish | Chaos: the order is still accepted (201), `order.publish_failed` is logged, the publisher reconnects on the next publish; the lost event stays lost (ADR-001 known limitation, asserted so it cannot change silently) | pass |
| NFR-6 graceful shutdown | Chaos: SIGTERM while 3000 messages are being consumed: exit code 0 (not killed), nothing lost, no duplicates, queue empty afterwards | pass |
| NFR-4 Redis down | `dependency-failures.chaos.mjs`: with Redis stopped, four orders in a row succeed (201) each in under 4 s through the user-service fallback, readiness stays green, the outage is exactly one warning line (not one per request or reconnect attempt), the event still reaches the worker; when Redis returns the log says so and caching resumes without a restart | pass |
| user-service down | Same file: a user that was cached keeps ordering; an uncached user gets `503` in under 8 s (2 s lookup timeout, one retry) with no internals in the body, `user lookup failed requestId=...` logged with the response's request id, and no order stored; through the gateway only `/v1/users` breaks (`502`, no upstream address), reading an order still works, gateway and order-service readiness stay green; after `user-service` returns, ordering works again without restarting anything | pass |
| PostgreSQL down (any service) | `database-failures.chaos.mjs`: readiness of user-service, order-service and notification-worker turns 503 while liveness stays 200 and the gateway stays ready; every business request (read, write, through the gateway) answers a clean `503` in under 10 s with no host names or SQL in the body and a `database.unavailable requestId=...` log line; authentication (`401`/`403`) still works because it does not need the database; when PostgreSQL returns, readiness and requests recover and no service container was restarted (compared by start time) | pass, after a fix (below) |
| Recovery of the rest of the stack | Chaos: after the database and broker were stopped, every service is ready again without a restart and the smoke test passes | pass |

**Defect found and fixed by the PostgreSQL scenario:** with the database down, business requests answered `500 Internal server error` after about four seconds, not the `503` this plan and the API rules call for. The three services that own a database now map database-unavailable errors (DNS, refused/reset connection, timeouts, server shutdown, connection exceptions) to a generic `503` through a global exception filter (`src/common/database-unavailable.filter.ts`, unit-tested including the cases that must stay 500) and set an explicit connect timeout of 2 s. Queries themselves still have no timeout; a database that accepts connections and then stalls is not covered.

Mutation checks: removing `enableShutdownHooks()` from the worker makes the graceful-shutdown scenario fail (exit code 137 instead of 0); making the cache rethrow its errors makes the Redis scenario fail on the first order (a cache outage would fail order creation); see also the `insert` versus `save` check in the identity-keycloak TEST-PLAN.

Gaps: query-level timeouts (a stalled but connected database); metrics are asserted by the observability tests, not by these scenarios; the workflow that runs these in CI (`platform-tests.yml`) passes on GitHub Actions.
