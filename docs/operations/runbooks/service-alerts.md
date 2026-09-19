# Runbook: platform alerts

What to do when an alert from `observability/prometheus/rules/platform.yml` fires. Alerts are visible in Prometheus (`http://localhost:9090/alerts`) and Grafana; dashboards: **Platform health** and **Application health** (`http://localhost:3000`). Commands are for the local compose stack. Related runbooks: [notification DLQ](notification-dlq.md), [Keycloak outage](keycloak-outage.md).

Start every investigation the same way: take a request id or trace id from a failing call (`x-request-id` is echoed in every response), open the trace in Grafana (Explore, Tempo) and follow the *Logs for this span* link, or query Loki with `{service_name=~".+"} | trace_id="<id>"`.

## ServiceNotReady

**Meaning:** a `/health/ready` probe (probed every 10 s by the collector) has not answered 2xx for a minute. Traffic to that instance is or should be removed; nothing is restarted because liveness is a separate probe.

1. Which one? The alert label `http_url` names it. Liveness tells you whether the process is alive at all (*Platform health, Liveness*).
2. Readiness is red for exactly two reasons: a hard dependency is down, or the process is unhealthy.
   - user-service, order-service: PostgreSQL. notification-worker: PostgreSQL **or** RabbitMQ (it is not consuming). gateway: only itself. Keycloak: its own database.
   - Check the dependency: `docker compose -f infrastructure/docker/docker-compose.yml ps`.
3. Fix or restart the dependency. Services recover by themselves, no restart needed (verified by the chaos suites).

## DatabaseUnavailable

**Meaning:** a service answered requests with `503` because PostgreSQL could not be reached (`database.unavailable` in its logs, with the request id). Readiness is red at the same time, so this usually comes with `ServiceNotReady`.

1. `docker compose ... ps postgres` and `logs postgres --tail 50`.
2. Start it (`docker compose ... up -d postgres`). Wait for the services' readiness to return; requests recover without restarts.
3. Orders placed meanwhile were **not** stored (clean 503, nothing half-written); clients retry.

## WorkerNotConsuming

**Meaning:** `notification.order-created` has no consumer. Orders keep being accepted; their notifications wait in the queue and are delivered when the worker returns (nothing is lost).

1. `docker compose ... ps notification-worker` and its logs (`notification.` lines, `RabbitMQ consumer error`).
2. If RabbitMQ is down, start it; the worker reconnects by itself. If the worker is down, start it.
3. Check *Messages waiting (ready)*: it drains after the worker is back. If it does not, see QueueBacklogGrowing.

## QueueBacklogGrowing

**Meaning:** more than 100 order events wait for the worker for five minutes: the worker is slower than the producers, or failing.

1. *Worker messages by outcome*: many `retried` means a dependency (usually PostgreSQL) is failing; many `dead_lettered` see the DLQ runbook.
2. *Worker processing time p95* and the worker's event-loop panels show saturation. Increase `WORKER_PREFETCH` or add worker replicas when it is only load.

## OrderEventsNotPublished

**Meaning:** an order was stored but its `order.created` event could not be published (RabbitMQ was unavailable). There is no outbox (ADR-001 known limitation), so **that order will never get a notification**.

1. Confirm: `order.publish_failed orderId=... correlationId=...` in the order-service logs.
2. Fix RabbitMQ (the publisher reconnects on its next publish).
3. Affected orders: list the `orderId`s from the log lines and create their notifications by publishing the events again (an operator task until an outbox exists), or accept the loss for a lab.

## HighErrorRate

**Meaning:** a service answered more than 5 % of its requests with a 5xx for five minutes (with real traffic).

1. *Application health, 5xx ratio* names the service; *Responses by status code* the codes.
2. Open a failing trace (Explore, Tempo: `{ resource.service.name = "<service>" && status = error }`) and read the span that failed; the logs of that trace show the cause.
3. A dependency outage shows up as `503` here as well as in its own alert; fix that first.

## HighLatency

**Meaning:** p95 latency of a service is above 1 s for five minutes.

1. *Latency p50 / p95 / p99* and *Gateway p95 by route* find the slow route.
2. In a slow trace the widest span is the culprit: a database query, the user lookup (`order-service` → `user-service`), or the process itself (see *Event loop delay*).

## GatewayAvailabilityBurn

Covers `GatewayAvailabilityFastBurn` (critical) and `GatewayAvailabilitySlowBurn` (warning).

**Meaning:** the gateway answers 5xx faster than its 99.5 % availability objective allows: fast burn spends the 30-day budget about 14 times too fast (5 m and 1 h windows), slow burn six times too fast (30 m and 6 h). *Application health, Error-budget burn rate* shows it.

1. The gateway only relays; find which backend produces the 5xx (*5xx ratio by service*) and follow HighErrorRate, DatabaseUnavailable or ServiceNotReady for it.
2. A `502`/`504` from the gateway itself means a backend is unreachable or too slow (`gateway.upstream_error` in its logs).

## GatewayLatencyBurn

**Meaning:** more than 30 % of gateway requests take longer than 500 ms (the objective allows 5 %), five minutes in a row and over the last hour. Follow HighLatency.

## TelemetryPipelineDown

Covers `TelemetryPipelineDown` and `TelemetryBeingDropped`.

**Meaning:** the collector, Tempo, Loki or Grafana is down, or the collector cannot deliver to a backend. **Services are unaffected** (exports are bounded and dropped), but metrics, traces or logs are missing for the gap.

1. `docker compose ... --profile observability ps`, then the component's logs.
2. Start it (`docker compose ... --profile observability up -d`). Telemetry resumes; data from the outage is not backfilled, and the dashboards show a gap.
3. Loki, Tempo and Prometheus store to named volumes with short retention (48 h); they survive restarts.
