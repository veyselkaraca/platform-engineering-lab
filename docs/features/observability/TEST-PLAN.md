# Feature: observability — Test Plan

Layers follow AGENTS.md §12.5, failure scenarios §28. Rule: telemetry is tested against the real backends; nothing here mocks Prometheus, Tempo or Loki.

## Layers

| Layer | What | Where |
|---|---|---|
| Unit (per service) | Custom metrics are emitted with the right names, labels and counts: auth refusals by reason, database-unavailable responses, worker outcomes and timing, order/publish/lookup/cache counters, gateway auth refusals | `services/*/test/*.spec.ts`, helper `test/support/metrics.ts` (in-memory `MeterProvider`) |
| Rule unit tests | Alert and recording rules against synthetic series | `observability/prometheus/tests/platform.test.yml` (`promtool test rules`) |
| Static configuration | Dashboards as code, alert annotations and runbook anchors, collector pipelines and redaction, retention, loopback ports, Grafana login | `tests/integration/observability-config.test.mjs` (regular suite, no stack), `promtool check rules/config`, collector `validate` |
| Live pipeline | One order seen as a trace, correlated logs and metrics; provisioned datasources, dashboards and rules | `tests/observability/pipeline.obs.mjs` (stack with the profile) |
| Failure and alerts | Collector outage, real failures firing and clearing alerts | `tests/chaos/observability-failures.chaos.mjs` (disruptive, slow) |

Not unit tested on purpose: `src/telemetry.ts` itself. It patches core modules process-wide, which would leak into other test files of the same Jest worker; the live pipeline test is its test.

## Requirement traceability

| Req | Verified by |
|---|---|
| OB-1 never blocks | Chaos: collector stopped, three orders in under 2.5 s each and all 201, readiness of all services green, stdout logs continue |
| OB-2 propagation | Live: one trace containing spans of all four services, the client's `traceparent` honored, publish and consume spans in the same trace, HTTP/DB/cache/user-lookup spans |
| OB-3 log correlation | Live: Loki returns lines of all four services for the trace id, each with `trace_id` and `span_id`, the request id survives; probes create no trace |
| OB-4 HTTP and resource metrics | Live: HTTP metrics for all four services with route templates (no ids, no probes), memory, CPU, event loop |
| OB-5 worker and broker | Unit: outcomes and timing; live: `notification_messages_total`, queue depth and consumers from RabbitMQ; chaos: a poison message shows up as `dead_lettered` and in the DLQ metric |
| OB-6 dependency metrics | Unit: each counter; live: lookups and cache counters present |
| OB-7 readiness probes | Live: readiness of all four services and Keycloak is a metric and all are 1; chaos: a stopped service turns it to 0 and back |
| OB-8 dashboards | Static: JSON structure, uids, datasources; live: both loaded in Grafana, every Prometheus query in them runs against the server; datasources healthy; cross-links present |
| OB-9 alerts | Rule tests for every alert group; live: all 13 alerts loaded, healthy, with severity and an existing runbook section; chaos: `TelemetryPipelineDown`, `ServiceNotReady`, `WorkerNotConsuming` and `DeadLetterQueueNotEmpty` fire for real failures and clear on recovery |
| OB-10 SLIs | Rule tests (burn rate fires at 10 % errors and not at 0.2 %; no errors reads 0, not "no data"); live: the SLI series exist |
| OB-11 no secrets | Live: token not in any span or log line, no `authorization`, a secret SQL parameter value in no span; static: collector redaction |
| OBN-1 overhead and cardinality | Live: no id-shaped labels; probes excluded |
| OBN-2 access | Static: loopback ports, opt-in profile, placeholder password; live: no anonymous Grafana access |
| OBN-3 retention | Static: declared for all three stores |
| OBN-4 declarative | Live: dashboards, datasources and rules present after a plain `up`, nothing configured by hand |
| OBN-5 validation | promtool check/test, collector `validate`, static tests; in CI before the stack tests |
| OBN-6 self-observability | Rules `TelemetryPipelineDown` / `TelemetryBeingDropped`; dashboard panels; chaos: collector stop fires the alert |
| OBN-7 survivable | Chaos: collector stopped and restarted: telemetry resumes without restarting a service |

## Failure scenarios

| Scenario | Expected | Detection | Recovery verified |
|---|---|---|---|
| Collector down | Requests unaffected and fast; stdout logs continue; telemetry dropped | `TelemetryPipelineDown` after 2 m | New requests traced and measured again, alert clears |
| A service or the worker stopped | Readiness probe 0; `WorkerNotConsuming` when the worker is down | `ServiceNotReady` (1 m), `WorkerNotConsuming` (1 m) | Alerts clear after both are back |
| Poison message dead-lettered | DLQ holds it, worker counts `dead_lettered` | `DeadLetterQueueNotEmpty` | Alert clears after the message is removed |
| Tempo or Loki down | Collector retries 30 s then drops | `TelemetryBeingDropped` | Not scripted (same mechanism as the collector case); rule-tested |
| PostgreSQL down, database 503s | `database_unavailable_responses_total` rises | `DatabaseUnavailable` | Rule-tested; the database outage itself is in the order-notification chaos suite |
| Broker down at publish | `order_events_publish_failures_total` rises | `OrderEventsNotPublished` | Rule-tested; not fired live because its 10-minute window would leave a firing alert behind for other tests |

## Running

```bash
docker compose -f infrastructure/docker/docker-compose.yml --profile observability up -d --build --wait
node --test --test-reporter=spec --test-concurrency=1 tests/observability/pipeline.obs.mjs
node --test --test-reporter=spec --test-concurrency=1 tests/chaos/observability-failures.chaos.mjs   # slow, disruptive
```

Order matters a little: the live pipeline test asserts that no alert is firing on a healthy stack, so run it before the chaos suites or wait about ten minutes after them (`DatabaseUnavailable` and `OrderEventsNotPublished` look back five and ten minutes).

## Results (as built, 2026-09-19)

| Check | Result |
|---|---|
| Service unit tests (lint, jest, `tsc`) | gateway 62, user-service 76, order-service 104, notification-worker 86 pass; lint clean; `npm audit --omit=dev` reports 0 vulnerabilities in all four after adding the OpenTelemetry packages |
| Rule unit tests (`promtool test rules`) | pass: readiness, DLQ, worker not consuming, error rate, database unavailable, availability burn (fires at 10 % errors, silent at 0.2 %), publish failures, keys unavailable, collector down, no errors reads 0 |
| `promtool check rules/config`, collector `validate` | pass |
| Regular suite (`tests/**/*.test.mjs`, includes the static observability checks) | 81 tests pass |
| Live pipeline (`pipeline.obs.mjs`) | 23 tests pass |
| Failure and alerts (`observability-failures.chaos.mjs`) | 3 scenarios pass in about eight minutes: collector down (orders 201, each under 2.5 s, stdout logs continue, `TelemetryPipelineDown` fires, telemetry resumes, alert clears); user-service and worker stopped (`ServiceNotReady` x2 and `WorkerNotConsuming` fire and clear); poison message (`DeadLetterQueueNotEmpty` fires and clears, worker counted `dead_lettered`) |
| Earlier chaos suites with telemetry switched on | broker, Redis/user-service, PostgreSQL and Keycloak scenarios all still pass. The graceful SIGTERM scenario still exits 0: the 5 s telemetry flush is bounded and runs inside the drain |
| actionlint | clean |

Defects found by these tests and fixed on the way:

- **SLI ratios read "no data" instead of 0** when there had been no 5xx at all (an empty numerator makes a division vanish): the availability panel would have been empty on a healthy system. Fixed with `or vector(0)` / `or (requests * 0)` and a rule test.
- **A stopped service kept looking ready.** When a probe cannot connect, the collector's HTTP check stops emitting the status series for that URL, and the Prometheus exporter kept the last value for five minutes, so readiness alerts were late and cleared five minutes late. `metric_expiration` is now one minute.
- **Collector config keys were silently ignored:** `resource_constant_labels` takes `included`, not `include` (unknown keys do not fail validation). Metrics lost their `service_name` label until the collector was recreated; the live tests caught it.
- **Worker without HTTP traffic has no HTTP metrics** (probes are excluded by design); the test now calls its API first instead of assuming the series exists.
- **The log panel of Application health showed a Loki parse error** (found by a user opening the dashboard; every earlier check only ran the Prometheus queries): the `service` variable's "All" expanded to `.*`, and Loki refuses a selector whose matchers can all be empty. `allValue` is now `.+`; a static test forbids an empty-compatible "All" or `=~".*"` in a Loki panel, and the live dashboard test now runs every Loki query too.
- **Chaos suites raced Keycloak's recovery:** after PostgreSQL was down, Keycloak answered 500 on the token endpoint for a while. The token helper now retries for up to a minute.

Remaining gaps, stated plainly:

- The dashboards were provisioned and every Prometheus and Loki query is run against the live servers; layout and readability were reviewed by a person once (which is how the log-panel error above was found), not by an automated check.
- `src/telemetry.ts` has no unit test (see above); a broken bootstrap would show up in the live pipeline test.
- Tempo/Loki outages and the `OrderEventsNotPublished` alert are rule-tested but not fired live.
- Log records include the full pino `req`/`res` objects as attributes, which is noisy in Loki; only the redaction is verified, not a trimmed schema.
- The new CI workflow steps (`platform-tests.yml`) have not run on GitHub; they were checked with actionlint and by running each command locally.
