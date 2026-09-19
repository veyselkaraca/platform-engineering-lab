# Feature: observability — Requirements

Status: **draft**. Delivers AGENTS.md §16 ("Observability Standards"), §7.6 ("Observable by Default") and the observability layer of §5: logs, metrics and traces that an operator can correlate across services, dashboards, alerts and basic SLIs/SLOs. It also closes the requirements the earlier features deferred to this slice: NFR-2 and NFR-7 of [order-notification](../order-notification/REQUIREMENTS.md) and IDN-7 of [identity-keycloak](../identity-keycloak/REQUIREMENTS.md).

## Problem

Today the only signal is JSON logs on each container's stdout. There is no way to follow one request across the gateway, order-service, user-service and the worker (the asynchronous hop through RabbitMQ included), no request/error/latency numbers, no view of queue depth or dead-lettered messages, and nothing that tells an operator *before* a customer does that something is wrong. Failure scenarios are tested (chaos suites) but only observable by reading logs.

## Scope

- OpenTelemetry instrumentation of api-gateway, user-service, order-service and notification-worker: traces, metrics and logs exported over OTLP to an OpenTelemetry Collector.
- Backends: Prometheus (metrics), Tempo (traces), Loki (logs), Grafana (dashboards, trace/log correlation, alert view).
- Broker and dependency health: RabbitMQ's own metrics, and health probes of the services and their hard dependencies.
- Dashboards and alert rules as code, including SLI recording rules and SLO burn-rate alerts.
- Local Docker Compose runtime, opt-in through a compose profile. CI runs the observability tests.

## Out of scope

Kubernetes/Helm packaging of the stack (its own slice; the configuration is written so it can be reused), Alertmanager and notification channels (no on-call target exists locally; alerts are evaluated and visible in Prometheus and Grafana), PostgreSQL/Redis exporters (dependency health comes from the services' own metrics and probes), long-term storage and multi-tenancy, front-end/browser telemetry, profiling, exemplars.

## Functional requirements

| ID | Requirement |
|---|---|
| OB-1 | Each service emits traces, metrics and logs over OTLP to the Collector. Instrumentation is always on; only the backends are opt-in. A missing or slow Collector never fails, delays or crashes a request or a consumer: exports are bounded (queue size, timeout) and dropped when the Collector is unavailable. |
| OB-2 | Trace context propagates over HTTP (client → gateway → services, order-service → user-service) **and over RabbitMQ** (order-service publish → worker consume), so a single order produces one trace covering the gateway, order-service, user-service and notification-worker. A W3C `traceparent` supplied by the client is honored. |
| OB-3 | Every log line written while handling a request or message carries `trace_id` and `span_id` (and keeps the existing request id / `correlationId`). Logs from all services are centrally queryable, by service and by trace id. Health-probe traffic does not produce traces or request logs. |
| OB-4 | Each service exposes HTTP server metrics: request rate, error rate and latency histogram by method, route and status class, plus runtime resource utilization (CPU, memory, event-loop delay). |
| OB-5 | The worker exposes counters for messages processed, duplicates ignored, retried, dead-lettered and failed, and a processing-time histogram. RabbitMQ exposes queue depth (ready and unacknowledged messages), consumer count and DLQ depth per queue, collected from the broker itself. |
| OB-6 | Dependency and outcome metrics: order events that failed to publish, user lookups by outcome, cache hits/misses/errors, requests answered `503` because the database was unreachable, and authentication/authorization rejections by reason (closes IDN-7). |
| OB-7 | The readiness of every service and the health of Keycloak and RabbitMQ are probed continuously and exposed as metrics, so "is it up and ready" is a query, not a `curl`. |
| OB-8 | Dashboards are provisioned from files: **Platform health** (service readiness, resource use, broker and queues, DLQ, dependency health) and **Application health** (rate/errors/latency per service, order → notification pipeline, auth rejections, dependency failures). From a log line the operator can jump to its trace and from a trace to its logs. |
| OB-9 | Alert rules are provisioned from files. Each alert is actionable, has a severity, a summary and a link to a runbook: service not ready, high 5xx ratio, high latency, DLQ not empty, worker not consuming, growing queue backlog, event publish failures, database unavailable, plus multi-window SLO burn-rate alerts. |
| OB-10 | SLIs are recorded as rules: gateway availability (non-5xx ratio) and gateway latency (share of requests under the latency objective). Objectives are stated in the design: availability 99.5 %, latency 95 % under 500 ms. |
| OB-11 | No secrets or personal data in telemetry: `Authorization`, `Cookie` and tokens are never recorded; SQL text is recorded without parameter values; request and message bodies are not recorded. |

## Non-functional requirements

| ID | Requirement |
|---|---|
| OBN-1 | Instrumentation overhead stays small: probes are excluded, span and metric attributes are low-cardinality (route templates, not raw URLs with ids), trace sampling is configurable (`OTEL_TRACES_SAMPLER`), default 100 % in the lab. |
| OBN-2 | The observability stack is opt-in (compose profile `observability`) so the default local stack stays light. Backend ports are published on loopback only. Grafana requires a login (no anonymous access); its admin password comes from `.env` with a fake sample value. |
| OBN-3 | Retention is bounded for local use and declared in configuration (metrics, traces, logs). Data lives in named volumes; nothing is written into the repository. |
| OBN-4 | All configuration is declarative files under `observability/` (Collector, Prometheus, Tempo, Loki, Grafana provisioning); no clicking in UIs is needed to get a working setup, and it is idempotent on repeated `up`. |
| OBN-5 | Configuration is validated automatically: Collector config, Prometheus config and rules (`promtool`), dashboard JSON, and the alert rules' unit tests where practical. |
| OBN-6 | The stack itself is observable: Collector, Prometheus, Tempo, Loki and Grafana have health checks and are scraped or probed. |
| OBN-7 | Backend or Collector outages are survivable and visible: services keep working (tested), and telemetry resumes when the backend returns. |

## Verification (feeds TEST-PLAN)

- Unit: telemetry bootstrap (config, sampler, exporters disabled/enabled), custom metric emission (auth rejections, worker counters), no sensitive attributes.
- Integration/e2e against the running stack: one order → one trace containing all four services; logs of that trace queryable in Loki; the expected metrics present in Prometheus; dashboards and datasources provisioned; alert rules loaded.
- Failure: Collector stopped → requests unaffected and telemetry resumes; DLQ message → `DeadLetterQueueNotEmpty` fires and clears; service stopped → `ServiceNotReady` fires.
- Static: `promtool check config/rules`, Collector `validate`, dashboard JSON parse, no secrets.

## Decisions

1. **Stack:** OpenTelemetry Collector → Prometheus + Tempo + Loki → Grafana. Logs, metrics and traces all go through the Collector (the "OpenTelemetry layer" of AGENTS.md §5); services send logs over OTLP as well as writing them to stdout, so no Docker socket is mounted anywhere.
2. **Opt-in:** compose profile `observability`; instrumentation is always on.
3. **No Alertmanager for now:** rules are evaluated by Prometheus and shown in Prometheus and Grafana. Adding Alertmanager is a small, separate change once a notification target exists.
4. **Dependency health:** from the Collector's HTTP check receiver and the services' own metrics, not from database/Redis exporters (each extra exporter is a container to run and monitor for little gain here).

## Related

[order-notification REQUIREMENTS](../order-notification/REQUIREMENTS.md) (NFR-2, NFR-7) · [identity-keycloak REQUIREMENTS](../identity-keycloak/REQUIREMENTS.md) (IDN-7) · AGENTS.md §16
