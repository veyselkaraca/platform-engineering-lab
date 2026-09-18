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
| api-gateway | One entry point: routing, request-id correlation, rate limiting (authentication arrives with Keycloak) | Downstream services per route (Keycloak JWKS later) | 502/504 with a structured error for the affected route only; readiness is independent of the backends so a backend outage never takes the gateway out of rotation |
| user-service | Owns user data | PostgreSQL | Readiness fails and traffic is removed; while it is unreachable the gateway answers 502 for `/v1/users` |
| order-service | Owns orders, emits events | PostgreSQL, user-service, RabbitMQ; Redis optional | Redis down → falls back to user-service; RabbitMQ down → order accepted, publish failure logged and alerted (see ADR-001 limitation); user-service down → 503 |
| notification-worker | Async consumer with retry/DLQ | RabbitMQ, PostgreSQL | Message retried with bound, then dead-lettered; healthy messages are not blocked |
| PostgreSQL | Persistent state, one DB per service | — | Dependent services fail readiness |
| Redis | Cache only | — | Degrades latency, not correctness |
| RabbitMQ | Async events | — | Publish/consume degrade; queue depth is alerted |
| Keycloak | Central identity | PostgreSQL (its own) | New logins fail; already-issued tokens keep validating until expiry |

Uniform for every component (stated once, verified per component in its README): observed through OpenTelemetry logs/metrics/traces and health endpoints; deployed by a Helm release built from an immutable `<service>:<commit-sha>` image; rolled back by redeploying the previous known-good image and config (AGENTS.md §15).

## Related docs

- Feature: [order-notification](../features/order-notification/REQUIREMENTS.md)
- Charter §8 (reference diagram), §14 (Kubernetes), §16 (observability)
