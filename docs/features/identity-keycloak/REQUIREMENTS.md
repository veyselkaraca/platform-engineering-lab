# Feature: identity-keycloak — Requirements

Status: **accepted** (open questions resolved, see Decisions). Adds centralized authentication (Keycloak, OIDC/OAuth2) and JWT-based authorization to the existing services, as required by AGENTS.md §19. It delivers the auth rules already assumed by [order-notification](../order-notification/REQUIREMENTS.md) (FR-1..FR-4) and [its DESIGN](../order-notification/DESIGN.md#auth).

## Problem

Today every endpoint is anonymous: anyone who can reach the gateway (or a service port) can create users and orders. The platform must show identity and authorization as two separate concerns: Keycloak authenticates and issues tokens; the services authorize from token claims. No service stores passwords.

## Scope

- Keycloak in the local Docker Compose stack, with a realm imported from version-controlled JSON.
- JWT verification in api-gateway (coarse: token present and valid) and in each service that exposes business endpoints (fine: roles and ownership).
- Realm roles `customer` and `admin`, applied per the order-notification endpoints.
- Smoke test and CI updated to obtain and use tokens.

## Out of scope

User self-registration, password reset/MFA flows, social login/federation, refresh-token handling in the services (clients own that), fine-grained permissions beyond two roles, service-to-service tokens (services trust each other on the internal network; revisit with Kubernetes network policies), Kubernetes/Helm deployment of Keycloak.

## Functional requirements

| ID | Requirement |
|---|---|
| ID-1 | Keycloak runs in the local stack with realm `platform-lab`, imported from `security/keycloak/realm/` on start. Import is idempotent. |
| ID-2 | The realm defines roles `customer` and `admin`, and one client per API audience (gateway-facing API client, plus a dev-only test client, see ID-9). Clients and roles live under `security/keycloak/{clients,roles}` or in the realm JSON, not created by hand. |
| ID-3 | api-gateway rejects requests to `/v1/*` without a valid bearer token with `401`. Health endpoints stay unauthenticated. |
| ID-4 | Token validation covers signature (JWKS), `iss`, `aud`, `exp` and `nbf`. Only asymmetric algorithms from the JWKS are accepted (`alg: none` and HMAC rejected). |
| ID-5 | order-service and user-service validate the token themselves; they do not trust a gateway-set identity header. Direct calls to a service port without a valid token get `401`. |
| ID-6 | Authorization per endpoint: `POST /v1/users` → `admin`. `GET /v1/users/{id}` → `admin` or the user themself. `POST /v1/orders` → `customer` acting for their own `userId` (an `admin` may act for any). `GET /v1/orders/{id}` → owner or `admin`. `GET /v1/notifications?orderId=` → owner of the order or `admin`. |
| ID-7 | A valid token without the required role, or whose ownership is decidable from the request alone (path/body id vs. `sub`), gets `403`, distinct from `401`. When ownership is only known after loading the resource, a non-owner gets the same `404` as for a resource that does not exist, so existence is not disclosed. |
| ID-8 | The token `sub` **is** the `userId` (no mapping table). `POST /v1/users` takes the Keycloak `sub` as the user's `id`. The rule is implemented in one place per service, not per endpoint. |
| ID-9 | Users are provisioned in the realm, not by the platform. The dev realm ships a test client and fake test users (one `customer`, one `admin`) with fixed ids so `scripts/smoke-test.sh` and CI can obtain tokens. Direct-grant/test users exist only in the dev realm export and are never in an environment-specific realm. |
| ID-10 | Correlation is preserved: `401/403` responses carry `x-request-id` and are logged with it. |

## Non-functional requirements

| ID | Requirement |
|---|---|
| IDN-1 | No secret, token, password or client secret is committed except clearly fake dev values (marked as such) in the dev realm and `.env.example`. Real values come from environment/secret stores. |
| IDN-2 | Tokens, `Authorization` headers and client secrets are never logged, including in error paths and the gateway's proxy logging. |
| IDN-3 | JWKS is fetched with an explicit timeout, cached, and refreshed on unknown `kid` with a bounded rate. Keycloak being briefly unreachable must not fail requests signed with an already-cached key. |
| IDN-4 | If no JWKS is available at all (cold start, Keycloak down) protected endpoints fail closed (`401`/`503`), never open. Liveness is unaffected; readiness reflects the JWKS dependency only if the service cannot verify tokens without it. |
| IDN-5 | Issuer, audience, JWKS URL and clock-skew tolerance are env-driven and validated at startup; the service refuses to start on missing/invalid auth config (same pattern as `validateEnv`). |
| IDN-6 | Access-token lifetime is short (minutes); clock-skew tolerance is small and bounded. |
| IDN-7 | Auth failures are counted (by reason: missing, expired, bad signature, wrong audience, forbidden) once the observability slice lands; until then they are structured log lines. |
| IDN-8 | Keycloak has its own PostgreSQL database created by `db-init` (idempotent), has a health check, and the compose stack stays reproducible from `scripts/bootstrap.sh`. |
| IDN-9 | Auth is never disabled to make a test pass. Tests get real tokens from the dev realm or locally signed tokens with a test JWKS; no `AUTH_DISABLED` flag. |

## Verification (feeds TEST-PLAN)

- Unit: token validation matrix (valid, expired, not-yet-valid, wrong `iss`, wrong `aud`, bad signature, `alg: none`, unknown `kid`), role and ownership checks.
- Compose/smoke: no token → `401`; `customer` token creating an order for another user → `403`; `customer` happy path through the gateway end to end; `admin` creates user.
- Failure: Keycloak stopped with a warm JWKS cache → requests still succeed; cold start with Keycloak down → fails closed.
- Security: grep/CI check that no token or secret appears in logs from the auth paths.

## Decisions

1. **`sub` ↔ `userId`:** `sub` is used as `userId` directly; `POST /v1/users` takes it as `id` (`users.id` is already a UUID, so no schema change).
2. **User provisioning:** users come ready in the realm. Creating them through the Keycloak admin API is out of scope; an admin only registers the matching record via `POST /v1/users`.
3. **Verification code:** a small module per service (no shared package until a second consumer justifies one).

## Related

[order-notification REQUIREMENTS](../order-notification/REQUIREMENTS.md) · [order-notification DESIGN — Auth](../order-notification/DESIGN.md) · AGENTS.md §19 · [ADR-001](../../decisions/ADR-001-stack-and-service-responsibilities.md)
