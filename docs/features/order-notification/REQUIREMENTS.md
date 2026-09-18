# Feature: order-notification — Requirements

The first end-to-end feature. Its purpose is to exercise sync calls, caching, persistence, async messaging, auth, and observability — not to model a real shop.

## Scope

An authenticated customer creates an order; the platform persists it, emits an event, and a worker records a notification for it.

## Functional requirements

| ID | Requirement |
|---|---|
| FR-1 | `POST /v1/users` (admin) registers a user record: `id` (the Keycloak `sub`), `email`, `name`. Id and email are unique. |
| FR-2 | `GET /v1/users/{id}` returns a user (admin, or the user themself). |
| FR-3 | `POST /v1/orders` (customer) creates an order: `userId`, `amount`, `description`. The user must exist. |
| FR-4 | `GET /v1/orders/{id}` returns an order (owner or admin). |
| FR-5 | Creating an order publishes one `order.created` event (`eventId`, `correlationId`, `occurredAt`, order payload). |
| FR-6 | notification-worker consumes `order.created` and stores one notification per event (simulated delivery). |
| FR-7 | Processing the same event twice produces one notification (idempotent). |
| FR-8 | Repeatedly failing messages are retried a bounded number of times, then dead-lettered without blocking other messages. |
| FR-9 | `POST /v1/orders` accepts an `Idempotency-Key` header; a repeated key returns the original order instead of creating another; a key already used by a different user gets 409, so one user's order is never returned to another. |

## Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Every service exposes `/health/live` and `/health/ready`; readiness reflects hard dependencies only. |
| NFR-2 | A request is traceable end to end by `x-request-id` / trace id across gateway, services, and the worker's log lines. |
| NFR-3 | Every outbound call has an explicit timeout. Retries only on idempotent GETs, bounded. |
| NFR-4 | Redis unavailable must not fail order creation. |
| NFR-5 | Errors are structured and never expose internals or secrets. Tokens/passwords are never logged. |
| NFR-6 | Services handle SIGTERM: stop accepting work, finish in-flight, close connections. |
| NFR-7 | Metrics per service: request rate, error rate, latency; worker: queue depth, processed/failed/dead-lettered counts. |

## Out of scope

Real email/SMS, payments, inventory, user self-registration, order updates/cancellation, pagination beyond a simple default.

## Related

[DESIGN.md](DESIGN.md) · [TEST-PLAN.md](TEST-PLAN.md) · [ADR-001](../../decisions/ADR-001-stack-and-service-responsibilities.md)
