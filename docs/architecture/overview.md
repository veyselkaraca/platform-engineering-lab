# Architecture Overview

The charter is [AGENTS.md](../../AGENTS.md); concrete choices are in [ADR-001](../decisions/ADR-001-stack-and-service-responsibilities.md). This page describes the platform as intended; components are marked as implemented only when their code lands.

## Request flow (first feature)

```text
Client ──JWT──▶ api-gateway ──▶ user-service ──▶ PostgreSQL (users)
                    │
                    └────────▶ order-service ──▶ PostgreSQL (orders)
                                   │  ├──────▶ user-service (validate user, sync)
                                   │  └──────▶ Redis (user lookup cache)
                                   │
                                   └─ publish order.created ─▶ RabbitMQ
                                                                  │
                                              notification-worker ◀┘ ──▶ PostgreSQL (notifications)
                                                                  └─ failures ─▶ retry queue ─▶ DLQ

Keycloak issues tokens; OpenTelemetry collector receives logs/metrics/traces from every service ─▶ Grafana.
```

Sync (HTTP) and async (RabbitMQ) paths are kept distinct on purpose: the sync path returns to the client; the async path is best-effort-with-recovery and never blocks the response.

## Component contract (AGENTS.md §26)

| Component | Why it exists | Depends on | On failure |
|---|---|---|---|
| api-gateway | One entry point: routing, request-id correlation, rate limiting, token authentication (a request without a valid token never reaches a backend) | Downstream services per route; Keycloak's key endpoint (cached) | 502/504 with a structured error for the affected route only; 503 if token keys cannot be fetched (never fails open); readiness is independent of the backends and of Keycloak so neither outage takes the gateway out of rotation |
| user-service | Owns user data (records keyed by the Keycloak `sub`) | PostgreSQL; Keycloak keys (cached) for token checks | Readiness fails and traffic is removed; while it is unreachable the gateway answers 502 for `/v1/users` |
| order-service | Owns orders, emits events | PostgreSQL, user-service, RabbitMQ; Redis optional | Redis down → falls back to user-service; RabbitMQ down → order accepted, publish failure logged and alerted (see ADR-001 limitation); user-service down → 503 |
| notification-worker | Async consumer with retry/DLQ | RabbitMQ, PostgreSQL | Message retried with bound, then dead-lettered; healthy messages are not blocked |
| PostgreSQL | Persistent state, one DB per service | — | Dependent services fail readiness (traffic removed, no restart) and answer `503` meanwhile; they recover by themselves when it returns |
| Redis | Cache only | — | Degrades latency, not correctness |
| OpenTelemetry Collector | Single ingestion point for traces, metrics and logs; probes service readiness | Tempo, Loki (Prometheus scrapes it) | Telemetry is dropped meanwhile (bounded, never blocks a request); `TelemetryPipelineDown` fires |
| Prometheus, Tempo, Loki, Grafana | Metrics + alerts, traces, logs, dashboards and correlation (`observability/`, compose profile `observability`) | the collector, RabbitMQ metrics | Gaps in dashboards; services unaffected |
| RabbitMQ | Async events | — | Publish/consume degrade; queue depth is alerted |
| Keycloak | Central identity (realm `platform-lab`, see `security/keycloak/README.md`) | PostgreSQL (its own database) | New logins fail; already-issued tokens keep validating while a service's key cache is warm (default 1 h); after that, and on a cold start, protected endpoints answer 503 (fail closed) while health stays green. Runbook: `docs/operations/runbooks/keycloak-outage.md` |

Uniform for every component (stated once, verified per component in its README): observed through OpenTelemetry logs/metrics/traces and health endpoints; deployed by a Helm release built from an immutable `<service>:<commit-sha>` image; rolled back by redeploying the previous known-good image and config (AGENTS.md §15).

## Related docs

- Feature: [order-notification](../features/order-notification/REQUIREMENTS.md)
- Charter §8 (reference diagram), §14 (Kubernetes), §16 (observability)
