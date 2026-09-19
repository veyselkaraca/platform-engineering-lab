# observability

Logs, metrics and traces for the four services, with dashboards and alerts as code. Feature docs: [docs/features/observability](../docs/features/observability/) (requirements, design, test plan). Alert runbook: [docs/operations/runbooks/service-alerts.md](../docs/operations/runbooks/service-alerts.md).

## Run it

The stack is opt-in (compose profile `observability`); the services always send telemetry and simply drop it when nothing listens.

```bash
sh scripts/bootstrap.sh
docker compose -f infrastructure/docker/docker-compose.yml --profile observability up -d --build --wait
```

| What | Where |
|---|---|
| Grafana (dashboards **Platform health**, **Application health**; Explore for traces and logs) | http://localhost:3000, user/password from `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` in `infrastructure/docker/.env` |
| Prometheus (rules, alerts, queries) | http://localhost:9090 |
| Tempo API / Loki API (used by Grafana and the tests) | http://localhost:3200, http://localhost:3100 |

All ports are bound to loopback. Data lives in named volumes (`prometheus-data`, `tempo-data`, `loki-data`, `grafana-data`); retention is 2 d (metrics) and 48 h (traces, logs).

To follow one request: send it with a `traceparent` header (or take the `x-request-id` from the response), open Grafana **Explore → Tempo** with the trace id, and use *Logs for this span*; or in Loki: `{service_name=~".+"} | trace_id="<trace id>"`.

## Layout

| Path | Contents |
|---|---|
| `otel/collector/config.yaml` | Collector: OTLP in; traces to Tempo, metrics for Prometheus to scrape, logs to Loki; memory limiter, batching, credential redaction; HTTP checks of every service's `/health/ready` and `/health/live` and of Keycloak |
| `prometheus/prometheus.yml` | Scrapes the collector (application metrics and its own), RabbitMQ (queue depth, consumers), Tempo, Loki, Grafana |
| `prometheus/rules/platform.yml` | SLI recording rules and the alert rules (13 alerts, each with severity, summary and runbook) |
| `prometheus/tests/platform.test.yml` | `promtool` unit tests of the rules |
| `tracing/tempo.yaml`, `logging/loki.yaml` | Trace and log stores (single process, local storage) |
| `grafana/datasources`, `grafana/provisioning`, `grafana/dashboards` | Datasources with trace/log cross-links, the dashboard provider, the two dashboards as JSON |

Deviations from the planned layout: no `otel/instrumentation` directory (instrumentation is code: `src/telemetry.ts` in each service); `tracing/` and `logging/` hold the Tempo and Loki configuration.

## Checks

```bash
# configuration (no stack needed)
docker run --rm --entrypoint promtool -v "$PWD/observability/prometheus:/p:ro" quay.io/prometheus/prometheus:v3.9.1 check rules /p/rules/platform.yml
docker run --rm --entrypoint promtool -v "$PWD/observability/prometheus:/p:ro" quay.io/prometheus/prometheus:v3.9.1 test rules /p/tests/platform.test.yml
docker run --rm -v "$PWD/observability/otel/collector/config.yaml:/c.yaml:ro" otel/opentelemetry-collector-contrib:0.161.0 validate --config=/c.yaml
node --test tests/integration/observability-config.test.mjs

# live pipeline (stack with the profile running)
node --test --test-reporter=spec --test-concurrency=1 tests/observability/pipeline.obs.mjs

# failures and alerts for real (disruptive, about ten minutes)
node --test --test-reporter=spec --test-concurrency=1 tests/chaos/observability-failures.chaos.mjs
```

## Changing dashboards

Dashboards are files and not editable in Grafana (`allowUiUpdates: false`). Edit the JSON (or build the panel in the UI, export it, and paste the JSON in) and restart Grafana or wait 30 s. The live test runs every Prometheus query in the dashboards against the server, so a typo fails a test instead of showing an empty panel.
