# Feature: identity-keycloak — Design

Implements [REQUIREMENTS.md](REQUIREMENTS.md). Extends [order-notification DESIGN — Auth](../order-notification/DESIGN.md#auth); where they differ, this document is the more specific one.

## Overview

```
client ── password grant (dev) / auth code (real) ──▶ Keycloak ──▶ access token (JWT, RS256)
client ── Authorization: Bearer <jwt> ──▶ api-gateway ──▶ user-service | order-service | notification-worker
                                            │ verifies         │ each verifies again, then authorizes (role + ownership)
                                            └──── JWKS (cached) ◀── Keycloak ─────┘
order-service ── forwards the caller's bearer ──▶ user-service (existence lookup)
```

Authentication (who are you, is the token genuine) and authorization (may you do this) are separate steps in separate code: the verifier produces a `Principal`, the endpoints decide from it.

## Keycloak and realm

- Image `quay.io/keycloak/keycloak:26.x` (pin an exact tag when implementing), added to `infrastructure/docker/docker-compose.yml` with its own PostgreSQL database `keycloak` (added to `db-init`'s `POSTGRES_MULTIPLE_DATABASES`; `KC_DB=postgres`). Command `start-dev --import-realm` with health enabled. `start-dev` is a local-only mode (HTTP, relaxed hostname); Kubernetes will use `start` with TLS, in its own slice.
- Host port `127.0.0.1:${KEYCLOAK_HOST_PORT:-8081}` (management port 9000 stays internal). Admin console credentials are `KC_BOOTSTRAP_ADMIN_*` from `.env`; `.env.example` gets fake values.
- Healthcheck against `:9000/health/ready` using bash `/dev/tcp` (the image has no curl).
- `KC_HOSTNAME=http://localhost:8081` pins the token `iss` so it is identical whether a client reaches Keycloak from the host or a container. Services still fetch keys through the internal URL, which does not affect `iss`.
- Realm file `security/keycloak/realm/platform-lab-dev.json`, mounted into `/opt/keycloak/data/import`. `--import-realm` skips an existing realm, so it is idempotent but does **not** apply later edits to a used volume. Applying a changed realm locally means dropping the `keycloak` database (documented in `security/keycloak/README.md`). Environment-specific realms (test/prod) are separate files created in the Kubernetes/Ansible slices.

### Realm content

| Item | Value |
|---|---|
| Realm | `platform-lab` |
| Realm roles | `customer`, `admin` (read from `realm_access.roles`) |
| API audience | `platform-api`: one audience shared by gateway and services. An audience mapper on the client scope adds it to `aud` (Keycloak does not by default). |
| Client `platform-lab-dev` | Public, direct access grants on, **dev realm only**. Used by smoke/CI/manual tests. |
| Users | `dev-customer` (role `customer`) and `dev-admin` (role `admin`), fixed UUIDs and fake passwords, all marked fake. |
| Token lifetime | Access token 5 min (IDN-6). No refresh handling in services. |

Fixed user ids are what make `sub == userId` scriptable: the smoke test registers `POST /v1/users {id: <dev-customer sub>, ...}` as `dev-admin`.

## Verification module (one per service: `src/auth/`)

Built on [`jose`](https://github.com/panva/jose) (`createRemoteJWKSet` + `jwtVerify`); hand-rolling JWKS caching and signature checks would be the riskier option. Pin **`^5`**: it ships CommonJS, while later majors are ESM-only, the same class of problem as NestJS 12 in this repo. Confirm the build still passes with `tsc` on Node 22.13 before adopting.

| File | Responsibility |
|---|---|
| `auth.config.ts` | Validate `AUTH_*` env at startup (IDN-5); fail fast like `validateEnv`. |
| `token-verifier.ts` | `verify(token) → Principal { sub, roles }`. Wraps `jwtVerify` with `issuer`, `audience`, `algorithms: ['RS256']`, `clockTolerance`. Takes the key resolver as a constructor argument (`createRemoteJWKSet` in production, `createLocalJWKSet` in tests). Maps errors to `TokenInvalid` (→401) or `KeysUnavailable` (→503). |
| `auth.guard.ts` | Global `APP_GUARD`: skips `@Public()` routes (health), reads `Authorization: Bearer`, verifies, sets `req.principal`, enforces `@Roles(...)`. |
| `auth.decorators.ts` | `@Public()`, `@Roles(...)`, `@CurrentPrincipal()`, `isAdmin(principal)`. |

The api-gateway is Express-level, not controller-based, so its copy is an Express middleware using the same `token-verifier.ts`; it checks validity only, not roles.

Rules the verifier enforces: signature via JWKS, `iss == AUTH_ISSUER`, `aud` contains `AUTH_AUDIENCE`, `exp`/`nbf` with small tolerance, algorithm allow-list (rules out `none` and HMAC-with-public-key confusion), `sub` present and a UUID.

### Configuration (per service, added to the existing env)

| Variable | Default | Note |
|---|---|---|
| `AUTH_ISSUER` | none | Expected `iss`, e.g. `http://localhost:8081/realms/platform-lab`. |
| `AUTH_AUDIENCE` | none | `platform-api`. |
| `AUTH_JWKS_URL` | none | Internal URL, e.g. `http://keycloak:8080/realms/platform-lab/protocol/openid-connect/certs`. |
| `AUTH_JWKS_TIMEOUT_MS` | 2000 | Explicit timeout on the key fetch (NFR-3). |
| `AUTH_JWKS_CACHE_SECONDS` | 3600 | See "Key refresh" below. |
| `AUTH_CLOCK_TOLERANCE_SECONDS` | 5 | Max 60. |

No secrets are involved: services only verify signatures with public keys. Compose sets these once via a YAML anchor shared by all four services.

### Key refresh and outage behavior (IDN-3, IDN-4)

- Keys are fetched lazily on the first token and cached for `AUTH_JWKS_CACHE_SECONDS`. An unknown `kid` (key rotation) triggers a refetch, rate-limited by jose's cooldown (30 s default), so a flood of garbage `kid`s cannot hammer Keycloak.
- Keycloak down, cache warm: verification keeps working until the cache expires. After that a refetch fails and requests get 503. This is deliberate: fail closed rather than trust stale keys forever. A rotated-away key stays accepted for up to the cache TTL, which is an accepted trade-off at this scale.
- Keycloak down, cold start: first requests get 503 (`KeysUnavailable`), never an allow.
- **Readiness does not depend on Keycloak.** If it did, an IdP blip would pull every replica out of rotation and turn a partial failure (only authenticated calls fail) into a full outage. Requests still fail closed on their own. Liveness is untouched.

### Error mapping

| Cause | Status | Body |
|---|---|---|
| Missing/malformed header, expired, bad signature/iss/aud/alg | 401 + `WWW-Authenticate: Bearer` | Generic structured error, same message for every cause. |
| Key fetch failed / timed out | 503 | Generic structured error. |
| Missing role, or `sub` ≠ path/body id | 403 | Generic structured error. |
| Non-owner reading an order-scoped resource | 404 | Identical to "not found" (ID-7). |

The specific reason (`missing`, `expired`, `signature`, `issuer`, `audience`, `keys_unavailable`, `forbidden`) goes only to the log: `auth.rejected requestId=… reason=…`, and for 403 also `sub` and route (auditability). The log never includes the token, any part of it, or the `Authorization` header. The existing request logger must have that header redacted; this is checked by a test (IDN-2).

## Authorization per endpoint

Roles are checked by the guard, ownership in the endpoint from `principal.sub` (one rule everywhere: `sub == userId`, or `isAdmin`).

| Endpoint | Role gate | Ownership rule | Failure |
|---|---|---|---|
| `POST /v1/users` (user-service) | `admin` | none | 403 |
| `GET /v1/users/{id}` | `customer` or `admin` | `id == sub` unless admin (from the path alone) | 403 |
| `POST /v1/orders` (order-service) | `customer` or `admin` | `dto.userId == sub` unless admin (from the body alone) | 403 |
| `GET /v1/orders/{id}` | `customer` or `admin` | `order.userId == sub` unless admin, checked after load | 404 |
| `GET /v1/notifications?orderId=` (worker) | `customer` or `admin` | customers get `WHERE user_id = sub` added to the query | empty list (indistinguishable from an order with no notifications) |

### Service-to-service call (order-service → user-service)

The user lookup must pass user-service's own authorization, and service-to-service tokens are out of scope. order-service therefore **forwards the caller's `Authorization` header** on the existence check. This works for both cases the API allows: a customer looking up themself (`id == sub`) and an admin. `UserDirectory.exists()` gains the header value as a parameter, and the header is never logged. Redis-cached "exists" answers are unaffected: authorization on the order request was already decided before the lookup.

### Changes to existing code

- **user-service:** `CreateUserDto` gains a required `id` (`@IsUUID()`); the entity's `@PrimaryGeneratedColumn('uuid')` becomes `@PrimaryColumn('uuid')`. No migration: the column and its default already exist, so the DB change is backward compatible and rollback stays safe. The unique-violation handler tells the two conflicts apart by constraint name (`users_pkey` vs `users_email_key`) and returns 409 with a different message for each. The global `ValidationPipe` is `forbidNonWhitelisted`, so a pre-change release would answer 400 to a body containing `id`; acceptable, because rollback is a security regression anyway (see below).
- **order-service:** ownership checks in `OrdersService`/controller, `UserDirectory` forwarding, removal of the "arrives with the Keycloak slice" comments.
- **notification-worker:** `findByOrder(orderId, userId?)`.
- **api-gateway:** middleware placed **after** the rate limiter (so unauthenticated floods hit the limit before costing a verification) and before the proxy; `Authorization` is forwarded unchanged. Client-supplied identity headers such as `x-user-id` are ignored everywhere because nothing reads them.

## Local runtime, smoke and CI

- `scripts/smoke-test.sh` gets an optional 5th argument (Keycloak base URL, default `http://localhost:8081`) and a `token_for <user>` helper (`curl` against the token endpoint, password grant on `platform-lab-dev`, credentials from the fake dev values). Direct service calls use the admin token; the gateway section runs the customer flow. New checks: no token → 401, customer creating an order for another user → 403.
- Services do **not** `depends_on` Keycloak (IDN-4: they start and stay live without it). The smoke script waits for the token endpoint instead.
- CI: `smoke-deps` in each service's caller workflow gains `keycloak`. Cost: an extra image pull and roughly a minute of start-up per pipeline run. Accepted; the alternative (skipping auth in CI) violates IDN-9.
- Networks: `quay.io` is a different registry from Docker Hub; on the corporate network it also goes through the proxy. Verify a pull before relying on it.

## Delivery slices (one coherent commit each)

1. Keycloak in compose + realm + `security/keycloak/README.md` (claim mapping) + `.env.example`; smoke token helper.
2. `src/auth/` in user-service + `id` change + authorization, together with order-service forwarding the caller's `Authorization` header on the user lookup (otherwise user-service enforcement would break order creation); smoke sends tokens on all direct calls.
3. order-service: `src/auth/`, role and ownership checks.
4. notification-worker: module, owner filter.
5. api-gateway: middleware; smoke gateway section, CI `smoke-deps`.
6. Docs: update `order-notification` docs where they now differ, CLAUDE.md "Current state".

Each slice keeps the stack green: the smoke script sends tokens from slice 2 on (harmless to services that do not enforce yet), and the gateway (slice 5) goes last so services are protected before the front door demands tokens. Order of deployment is otherwise free: the gateway forwards `Authorization`, so mixed versions during a rolling update still behave.

## Rollback

Auth is additive to the schema, so rolling a service back to the previous image works without data changes. It also re-opens that service's anonymous endpoints, so a rollback of this feature is a known security regression and must be recorded as such. Keycloak itself is stateless apart from its database; rolling it back means the previous image tag with the same volume, and the realm JSON is versioned in git.

## Risks and limits

- Realm import does not update an existing realm (see above); documented, not worked around.
- Up to `AUTH_JWKS_CACHE_SECONDS` of accepted-after-rotation window and of outage tolerance; the same knob controls both.
- No token revocation check (stateless JWTs): a stolen token is valid until `exp` (5 min). Introspection would add a per-request dependency and is not warranted for this lab.
- Four small copies of the verifier. Divergence is guarded by each service running the same test matrix (see TEST-PLAN); extract a package when a second reason to share code appears.
