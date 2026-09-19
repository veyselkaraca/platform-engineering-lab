# Feature: observability — Design

Status: **implemented** (deviations from the first plan are marked *as built*). Implements [REQUIREMENTS.md](REQUIREMENTS.md).

## Overview

```
 api-gateway ─┐
 user-service ─┤  OTLP/HTTP (traces, metrics, logs)               ┌──▶ Tempo  (traces)  ──┐
 order-service ┼──────────────────────────▶ OpenTelemetry ────────┼──▶ Loki   (logs)    ──┼──▶ Grafana
 notification- ┘                            Collector             └──▶ :8889 ◀─scrape── Prometheus ─┘
   worker                                    ▲   │ also probes /health/{live,ready} of the services and Keycloak
 RabbitMQ (rabbitmq_prometheus) ─────────────┼───┼────────────────────────────▶ Prometheus (scrape :15692)
 collector, Tempo, Loki, Grafana self metrics ┴───┴───────────────────────────▶ Prometheus
```

Everything an operator needs to follow one request is joined by the **trace id**: the trace in Tempo, the log lines in Loki (`trace_id` structured metadata) and, through the service and route labels, the metrics in Prometheus. Grafana links log line → trace and trace → logs.

## Components

| Component | Image (exact tag) | Role | Host port (loopback) |
|---|---|---|---|
| OpenTelemetry Collector | `otel/opentelemetry-collector-contrib:0.161.0` | Single ingestion point; batching, memory limiter, redaction; HTTP checks | none (OTLP 4317/4318 internal, self metrics 8888) |
| Tempo | `grafana/tempo:2.8.2` | Trace store, single-process, local storage, 48 h retention | 3200 |
| Loki | `grafana/loki:3.7.8` | Log store, single-process, OTLP ingestion, 48 h retention | 3100 |
| Prometheus | `quay.io/prometheus/prometheus:v3.9.1` | Metrics, recording and alert rules, 2 d retention | 9090 |
| Grafana | `grafana/grafana:12.3.3` | Dashboards, Explore, correlation; login required | 3000 |

All five are in the compose profile `observability` (`docker compose -f infrastructure/docker/docker-compose.yml --profile observability up -d --build --wait`) and use named volumes. Tempo 3.x was not adopted (major version with a different ingest architecture); 2.8.2 is the stable monolithic setup. The Collector and Loki images have no shell, so they have no compose health check; Prometheus scrapes their self metrics (`up`, alert `TelemetryPipelineDown`) and Grafana checks the Loki datasource.

Configuration lives under `observability/`: `otel/collector/config.yaml`, `prometheus/{prometheus.yml,rules/,tests/}`, `tracing/tempo.yaml`, `logging/loki.yaml`, `grafana/{datasources,provisioning,dashboards}`. *As built:* the `otel/instrumentation` placeholder was dropped, because instrumentation is code in each service (`src/telemetry.ts`).

## Instrumentation (per service, `src/telemetry.ts`)

`import './telemetry'` is the **first line of `main.ts`**: instrumentations patch modules as they are first required, and metric instruments created before the SDK is registered stay no-ops for life. Each service has its own copy (like `src/auth/`); change them together.

| Instrumentation | gateway | user | order | worker |
|---|---|---|---|---|
| http (server + client), express | yes | yes | yes | yes |
| nestjs-core | | yes | yes | yes |
| pg (statements without parameter values) | | yes | yes | yes |
| ioredis | | | yes | |
| amqplib (publish/consume spans, context in message headers) | | | yes | yes |
| undici (`fetch` to user-service) | | | yes | |
| pino (adds `trace_id`/`span_id`, sends log records over OTLP) | yes | yes | yes | yes |
| runtime-node (event loop delay/utilization, heap, GC) | yes | yes | yes | yes |

Extra: `process.memory.usage` (RSS) and `process.cpu.time` (by mode) observables. Health probes (`/health*`) are excluded from traces and HTTP metrics. Standard `OTEL_*` variables configure it (compose sets `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_SEMCONV_STABILITY_OPT_IN=http`, `OTEL_TRACES_SAMPLER` default `parentbased_always_on`, and resource attributes `service.namespace=platform-lab`, `deployment.environment.name=local`). `OTEL_SDK_DISABLED=true` switches it off.

**Never blocking (OB-1):** OTLP exporters have a 3 s timeout, the log processor a bounded queue (2048 records), spans use the SDK's bounded batch queue, metrics export every 15 s. Nothing runs on the request path except starting a span. `TelemetryLifecycle` flushes on SIGTERM, bounded to 5 s.

**Propagation (OB-2):** W3C `traceparent` in HTTP (the gateway continues a client-supplied one, `http-proxy` forwards it) and in the RabbitMQ message headers (amqplib instrumentation). One order is one trace: gateway → order-service → (Redis, PostgreSQL, user-service, RabbitMQ publish) → worker consume → PostgreSQL. The gateway labels its spans and metrics by matched route prefix (`/v1/orders`), not by the catch-all Express route.

**Logs (OB-3):** the existing JSON logs on stdout are unchanged (plus `trace_id`, `span_id`, `trace_flags`); the same records are sent as OTLP logs. `x-request-id` remains in `req.id` and the worker's `correlationId`.

## Metric catalog

Prometheus names (dots become underscores, counters get `_total`, units are appended). All carry `service_name` and `service_namespace` (the exporter's `resource_constant_labels.included`; note the key is `included`).

| Metric | Labels | Source | Requirement |
|---|---|---|---|
| `http_server_request_duration_seconds_{bucket,count,sum}` | `http_request_method`, `http_route`, `http_response_status_code` | http instrumentation | OB-4 |
| `http_client_request_duration_seconds_*` | | http, undici | OB-4 |
| `process_memory_usage_bytes`, `process_cpu_time_seconds_total{cpu_mode}` | | telemetry.ts | OB-4 |
| `nodejs_eventloop_delay_*_seconds`, `nodejs_eventloop_utilization_ratio`, `v8js_*` | | runtime-node | OB-4 |
| `db_client_connection_count{db_client_connection_state}`, `db_client_operation_duration_seconds_*` | | pg | OB-6 |
| `notification_messages_total{outcome}` | processed, duplicate, retried, dead_lettered, dead_letter_failed | worker | OB-5 |
| `notification_processing_duration_seconds_*` | `outcome` | worker | OB-5 |
| `rabbitmq_detailed_queue_{messages_ready,messages_unacked,consumers}` | `queue` | RabbitMQ plugin, scraped at `/metrics/detailed` | OB-5 |
| `orders_created_total` | | order-service | OB-6 |
| `order_events_publish_failures_total` | | order-service | OB-6 (the ADR-001 limitation, visible) |
| `user_lookups_total{outcome}` | cache_hit, found, not_found, unavailable | order-service | OB-6 |
| `cache_operations_total{operation,outcome}` | get/set × hit/miss/ok/error | order-service | OB-6 |
| `database_unavailable_responses_total` | | user, order, worker | OB-6 |
| `auth_rejections_total{reason}` | missing, expired, not_yet_valid, signature, issuer, audience, claims, malformed, keys_unavailable, role, not_owner | all four | OB-6, IDN-7 |
| `httpcheck_status{http_url,http_status_class}`, `httpcheck_duration_milliseconds` | | collector HTTP check, every 10 s | OB-7 |

Cardinality rules: labels are route templates and small enums; never ids, users, URLs with parameters or messages. A test asserts no id-shaped route label exists.

## Dashboards (Grafana, provisioned from `observability/grafana/dashboards`, not editable in place)

- **Platform health**: readiness and liveness of every service, Keycloak and RabbitMQ (stat plus over time), resources (memory, CPU, event loop), broker (ready/unacked per queue, DLQ depth, consumers, worker outcomes), dependencies (DB connections, `503`-because-DB, user lookups, cache, publish failures, Keycloak keys), the telemetry pipeline itself, recent warnings and errors from every service.
- **Application health** (variable `service`): gateway SLOs and error-budget burn rate, request rate, 5xx ratio, status codes and latency p50/p95/p99 per service, gateway by route, the order → notification pipeline (orders created vs processed, processing time, outcomes, idempotent replays), auth refusals by reason, logs of the selected services.

Datasources (`observability/grafana/datasources`) cross-link: Loki derived field `trace_id` → Tempo, Tempo `tracesToLogsV2` → Loki (filter by trace id).

## Alerts and SLOs (`observability/prometheus/rules/platform.yml`)

Recording rules: per-service request rate, 5xx rate and ratio; gateway 5xx ratio over 5 m/30 m/1 h/6 h (a window without any 5xx reads 0, not "no data"); gateway share of requests slower than 500 ms over 5 m/1 h.

**Objectives:** gateway availability **99.5 %** (5xx are failures, 4xx are not); gateway latency **95 % of requests under 500 ms**.

| Alert | Severity | Fires when | For |
|---|---|---|---|
| `ServiceNotReady` | critical | a `/health/ready` probe is not 2xx | 1 m |
| `DatabaseUnavailable` | critical | requests answered 503 because PostgreSQL is unreachable | 1 m |
| `AuthenticationKeysUnavailable` | critical | a service cannot fetch Keycloak's keys (fail closed) | 1 m |
| `WorkerNotConsuming` | critical | no consumer on `notification.order-created` | 1 m |
| `DeadLetterQueueNotEmpty` | warning | a DLQ has messages | 1 m |
| `QueueBacklogGrowing` | warning | more than 100 events waiting | 5 m |
| `OrderEventsNotPublished` | warning | an order's event could not be published | immediately |
| `HighErrorRate` | warning | a service answers > 5 % 5xx with real traffic | 5 m |
| `HighLatency` | warning | p95 above 1 s with real traffic | 5 m |
| `GatewayAvailabilityFastBurn` | critical | 5xx ratio above 14.4 × budget over 5 m **and** 1 h | 2 m |
| `GatewayAvailabilitySlowBurn` | warning | above 6 × budget over 30 m **and** 6 h | 15 m |
| `GatewayLatencyFastBurn` | warning | more than 30 % of requests over 500 ms (5 m and 1 h) | 5 m |
| `TelemetryPipelineDown`, `TelemetryBeingDropped` | warning | a component is down, or the collector cannot deliver | 2 m, 5 m |

Each has `severity`, `summary`, `description` and a `runbook` annotation pointing at a section of [service-alerts.md](../../operations/runbooks/service-alerts.md) (or the DLQ / Keycloak runbook). The rules have `promtool` unit tests (`observability/prometheus/tests`). No Alertmanager: alerts are evaluated and visible in Prometheus and Grafana; a receiver is added when a notification target exists.

## Privacy and security (OB-11, OBN-2)

- Tokens and `Authorization` never enter telemetry: HTTP instrumentation does not record request headers, pino redacts them in the log record, the collector deletes `http.request.header.authorization/cookie` from traces and logs as defence in depth, and a test looks for the token in Tempo and Loki.
- SQL is recorded with placeholders; a test asserts a secret request value does not appear in any span.
- Ports are on loopback; Grafana has a login (`GRAFANA_ADMIN_*` in `.env`, fake sample value), no anonymous access, no sign-up, no analytics.
- No Docker socket is mounted anywhere: logs travel over OTLP.

## Failure behavior (OBN-7)

| Failure | Behavior |
|---|---|
| Collector down | Requests unaffected and not slower; stdout logs continue; exports are dropped after their timeout; `TelemetryPipelineDown` fires after 2 m; when it returns, new requests are traced and measured again (no backfill). |
| Tempo or Loki down | The collector retries for up to 30 s then drops; `TelemetryBeingDropped` fires; services unaffected. |
| Prometheus down | Nothing is evaluated or scraped meanwhile; the collector keeps the latest metrics for scraping (5 m expiry). |
| No observability profile | Instrumentation still runs; exports fail fast and are dropped. Cost: a failed DNS lookup per export. |

## Limitations, stated plainly

- Local single-node storage, short retention, no HA. Kubernetes packaging (Helm) reuses these files in its own slice.
- Traces are sampled at 100 % (`parentbased_always_on`); tail sampling is not implemented.
- The `http_route` of unmatched requests is `/` (the framework's catch-all); a test only asserts that no id-shaped route appears.
- Failed exports are silent by design (the SDK's diagnostics are off); the collector's own metrics and `TelemetryBeingDropped` are the signal, plus a missing panel in Grafana.
- Instruments must be created after the SDK is registered; `telemetry.ts` first in `main.ts` guarantees it, and the unit-test helper `test/support/metrics.ts` must be imported first in test files that read metrics.
- PostgreSQL and Redis have no exporters; their health is inferred from the services' metrics and probes.
- Dashboards were validated by loading them into Grafana and running every query against Prometheus; they were not reviewed visually in a browser session here.
