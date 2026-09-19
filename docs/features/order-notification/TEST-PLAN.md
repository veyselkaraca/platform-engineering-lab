# Feature: order-notification — Test Plan

Layers follow AGENTS.md §12.5. Failure scenarios follow §28: for each, record what failed, how it was detected, the evidence, the automated behavior, any operator action, and how recovery is verified.

## Layers

| Layer | Covers |
|---|---|
| Unit | Validation, idempotency-key logic, cache fallback, retry-count logic, role/ownership rules |
| Integration (`tests/integration`) | Each service against real PostgreSQL/Redis/RabbitMQ (containers): migrations, unique constraints, publish/consume, DLQ routing |
| Contract (`tests/contract`) | order-service ↔ user-service HTTP (`order-user-lookup.test.mjs`), and the `order.created` event schema as really published (`order-created-event.test.mjs`) |
| E2E (`tests/e2e`) | Token from Keycloak → gateway → order → notification stored; one trace id across services |
| Smoke (`scripts/smoke-test.sh`) | Post-deploy: health endpoints, one create-order round trip |
| Chaos (`tests/chaos`) | Scenarios below: `broker-failures.chaos.mjs` (async path, DB and broker outages, graceful stop) and `keycloak-outage.sh` |

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

## Results (as built, 2026-09-19)

Run with the stack up: `node --test --test-concurrency=1 "tests/**/*.test.mjs"` (integration, contract, e2e; 64 tests) and, on purpose because it is disruptive, `node --test --test-concurrency=1 tests/chaos/broker-failures.chaos.mjs` (7 scenarios, about three minutes). Broker access is through RabbitMQ's management API, so the tests need nothing installed.

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
| Recovery of the rest of the stack | Chaos: after the database and broker were stopped, every service is ready again without a restart and the smoke test passes | pass |

Mutation checks: removing `enableShutdownHooks()` from the worker makes the graceful-shutdown scenario fail (exit code 137 instead of 0); see also the `insert` versus `save` check in the identity-keycloak TEST-PLAN.

Gaps: NFR-4 (Redis down) and the user-service outage scenario are not scripted yet; no metrics assertions until the observability slice; the workflow that runs these in CI (`platform-tests.yml`) has not run on GitHub yet.
