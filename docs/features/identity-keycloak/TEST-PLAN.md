# Feature: identity-keycloak — Test Plan

Layers follow AGENTS.md §12.5, failure scenarios §28. Rules: auth is never disabled to pass a test (IDN-9); unit tests use locally signed tokens, compose/smoke/e2e use real Keycloak tokens.

## Layers

| Layer | Covers |
|---|---|
| Unit (per service) | Token verifier matrix, guard, role and ownership rules, config validation, log redaction |
| Integration (`tests/integration`) | user-service against real PostgreSQL through the running stack (`users-store.test.mjs`); static identity-config checks (`identity-config.test.mjs`). The verifier against a real HTTP JWKS endpoint lives in each service's `test/jwks-outage.spec.ts` |
| Contract (`tests/contract`) | order-service → user-service lookup with a forwarded bearer token (`order-user-lookup.test.mjs`) |
| E2E (`tests/e2e`) | Real Keycloak token → gateway → order → notification, for customer and admin; forged tokens refused at the gateway and every service (`order-flow.test.mjs`) |
| Smoke (`scripts/smoke-test.sh`) | Auth checks listed below, run post-deploy and in CI |
| Chaos (`tests/chaos`) | Keycloak stopped with warm/cold cache |

## Unit: test seam

Tests generate an RSA key pair with `jose` (`generateKeyPair`, `SignJWT`), build the verifier with `createLocalJWKSet`, and sign tokens with chosen claims. Each service carries the same small helper (`test/support/tokens.ts`) and the same verifier matrix, so the four copies cannot drift unnoticed.

### Token verifier matrix (every service, including gateway)

| Case | Expected |
|---|---|
| Valid token, roles `customer` | `Principal { sub, roles }` |
| Valid token, roles `admin` | Principal with `admin` |
| Expired | 401 |
| `nbf` in the future beyond tolerance | 401 |
| `exp` just past, within clock tolerance | accepted |
| Wrong `iss` (other realm) | 401 |
| Wrong `aud` (e.g. `account` only) | 401 |
| Signed by an unknown key (`kid` not in set) | 401 |
| Valid `kid`, tampered payload | 401 |
| `alg: none` | 401 |
| HS256 signed with the public key as secret | 401 |
| Missing `Authorization`, non-Bearer scheme, empty token, garbage string | 401 |
| `sub` missing or not a UUID | 401 |
| No `realm_access` claim | Principal with no roles (then 403 at a role gate, not 401) |
| Key resolver throws a fetch error/timeout | 503, not 401 and never an allow |

All 401s carry `WWW-Authenticate: Bearer`, an identical generic body regardless of cause, and `x-request-id` (ID-10).

## Unit: authorization matrix

Run per service against its own endpoints with the Nest testing module and real guard.

| Endpoint | anonymous | customer (self) | customer (other) | admin |
|---|---|---|---|---|
| `POST /v1/users` | 401 | 403 | 403 | 201 |
| `GET /v1/users/{id}` | 401 | 200 | 403 | 200 |
| `POST /v1/orders` | 401 | 201 (`userId == sub`) | 403 (`userId != sub`) | 201 for any existing user |
| `GET /v1/orders/{id}` | 401 | 200 (owner) | 404 (same body as unknown id) | 200 |
| `GET /v1/notifications?orderId=` | 401 | rows (owner) | `[]` | rows |

Extra cases: a token with neither role gets 403 on every gated endpoint; `/health/live` and `/health/ready` need no token; a request carrying a forged `x-user-id`/`x-roles` header is treated exactly like one without it (ID-5).

### Other unit tests

- **Config (IDN-5):** each of `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL` missing or invalid stops startup with a clear error; `AUTH_CLOCK_TOLERANCE_SECONDS` above 60 rejected.
- **user-service:** `POST /v1/users` requires a UUID `id`; duplicate `id` and duplicate email both give 409 with different messages; a body without `id` gives 400.
- **order-service:** `UserDirectory` sends the caller's `Authorization` header to user-service, sends no header when the lookup is served from Redis, and never logs the header value.
- **Redaction (IDN-2):** capture log output for a rejected and an accepted request carrying a recognizable token string; assert the string, the `Authorization` header and any token fragment are absent. Also assert the `auth.rejected` line has `requestId` and `reason` and, for 403, `sub`.
- **Gateway:** rate limiter runs before the verifier (a burst of invalid tokens gets 429 after the limit); the `Authorization` header reaches the upstream unchanged; health routes bypass auth.

## Integration

Verifier against a local HTTP server serving a JWKS (no Docker needed, so it can run in the per-service unit job):

| Case | Expected |
|---|---|
| Server up, first token | Fetches keys, accepts |
| Server then closed, second token, cache warm | Still accepted (IDN-3) |
| Cache TTL elapsed (short TTL in test), server closed | 503 |
| Fresh verifier, server closed (cold start) | 503, never accepted (IDN-4) |
| Server slow beyond `AUTH_JWKS_TIMEOUT_MS` | 503 within roughly the timeout, request not hanging |
| Rotation: new `kid` appears in the set | Refetched on first unknown `kid`, accepted |
| Many unknown-`kid` tokens in a burst | At most one refetch per cooldown window (server request count asserted) |

PostgreSQL-backed: unique violation on `users_pkey` vs `users_email_key` maps to the two distinct 409s.

## Contract

order-service ↔ user-service: with a forwarded customer token for `sub == userId`, user-service answers 200 for an existing user and 404 for a missing one (so order-service returns 201/422); with an unrelated customer token it answers 403, which order-service must surface as 503 (existing unexpected-4xx path), never as "user missing" (a wrong 422 would mask an auth bug). Verify that behavior explicitly.

## Smoke (`scripts/smoke-test.sh`, real Keycloak)

1. Token endpoint reachable; `dev-admin` and `dev-customer` tokens obtained.
2. Direct service call without token → 401 (user-service, and each further service given).
3. Admin registers the customer's record (`id = dev-customer sub`) via `POST /v1/users`; re-running is safe (an existing id is tolerated as 409).
4. Customer creates an order for self through the gateway → 201, idempotent replay → same order, notification appears (existing async check, now with a token).
5. Customer creating an order for another user → 403.
6. Customer calling `POST /v1/users` → 403.
7. A tampered token (last character of the signature changed) → 401.

The smoke script prints no token values (IDN-1/2): use `curl -sS` output capture only into variables, and `set +x`.

## E2E (`tests/e2e`, when the harness exists)

Real token → gateway → order created → event → notification stored, for both roles. Also a token from a *different* realm (create a throwaway realm or sign locally with an unknown key) is rejected at the gateway.

## Chaos

| Scenario | Steps | Expected |
|---|---|---|
| Keycloak down, warm cache | Make authenticated calls, `docker compose stop keycloak`, repeat calls | Still 200/201 until cache TTL (use a short TTL for the test) |
| Keycloak down past TTL | Continue after TTL | 503 on protected endpoints; `/health/live` and `/health/ready` still 200 |
| Keycloak down, cold service | Restart a service with Keycloak stopped | Service starts and stays ready; protected calls 503, never 200 |
| Keycloak recovers | `docker compose start keycloak` | Protected calls succeed again without restarting services |

Scripted in `tests/chaos/keycloak-outage.sh`, which also runs the "past TTL" case with `AUTH_JWKS_CACHE_SECONDS=5` (a compose variable) and restores the default afterwards.

## Requirement traceability

| Req | Verified by |
|---|---|
| ID-1, ID-2 | Smoke step 1 (realm imported, roles/clients usable); realm JSON review; re-`up` on an existing volume is a no-op |
| ID-3 | Gateway unit tests; smoke step 2 via gateway |
| ID-4 | Verifier matrix (iss, aud, exp, nbf, alg, signature) |
| ID-5 | Direct-to-service no-token tests; forged identity headers ignored |
| ID-6 | Authorization matrix; smoke steps 3 to 6 |
| ID-7 | Matrix: 403 vs 404 vs empty list; identical body for non-owner and unknown id |
| ID-8 | user-service `id` tests; ownership tests use `sub` |
| ID-9 | Smoke uses the dev users; `tests/integration/identity-config.test.mjs` fails if any non-dev realm file has users or direct-grant clients |
| ID-10 | 401/403 responses carry `x-request-id`; log line asserted |
| IDN-1 | Secret scan in CI (gitleaks or equivalent when the SAST slice lands); review that every credential in the realm and `.env.example` is marked fake |
| IDN-2 | Redaction unit tests; chaos/smoke logs grepped for the token |
| IDN-3, IDN-4 | Integration JWKS cases; chaos scenarios |
| IDN-5 | Config unit tests |
| IDN-6 | Realm file review (5 min access token); clock-tolerance bound in config test |
| IDN-7 | Log-line assertions now; metric assertions when observability lands |
| IDN-8 | `docker compose up -d --wait` reaches healthy Keycloak from a clean volume and on re-run; `db-init` idempotent with the new database |
| IDN-9 | Review gate: no auth bypass flag or env in code; tests use signed/real tokens |

## Failure scenarios

| Scenario | Expected behavior | Detection | Recovery verified |
|---|---|---|---|
| Missing/invalid/expired token | 401, no downstream call | `auth.rejected` log, later auth-failure metric | Retry with a fresh token succeeds |
| Valid token, wrong role or non-owner | 403 (or 404/empty per ID-7), audit log with `sub` | `auth.forbidden` log | n/a |
| Keycloak down, cache warm | Requests continue | Keycloak health, key-fetch error log | Automatic |
| Keycloak down, cache expired or cold | Protected endpoints 503, health unaffected, never fail open | 503 rate, key-fetch error log | Keycloak up, next request succeeds, no restart |
| JWKS slow | 503 within the fetch timeout, no request pile-up | Key-fetch timeout log, latency | Same as above |
| Key rotation | Unknown `kid` triggers one refetch, then accepted | Refetch log | Verified by rotation integration test |
| Clock skew between services and Keycloak | Small skew tolerated, larger yields 401 `nbf`/`exp` | `auth.rejected reason=expired/nbf` | Fix time sync; tolerance stays bounded |
| Realm edited but volume reused | Change not applied (import skips existing realm) | Realm content differs from git | Drop `keycloak` database and re-`up` (documented) |
| Rollback of a service | Endpoints anonymous again | Release notes; smoke step 2 fails | Roll forward; recorded as a security regression |

## Running the cross-service tests

The stack must be up (`docker compose -f infrastructure/docker/docker-compose.yml up -d --build --wait`), then from the repo root:

```bash
node --test --test-concurrency=1 --test-reporter=spec "tests/**/*.test.mjs"
sh tests/chaos/keycloak-outage.sh
```

Node's built-in runner, no dependencies. They also run in CI (`.github/workflows/platform-tests.yml`). The tests leave data behind (new users and orders in the local databases) and rely on `dev-other` never having a user record. Environment overrides: `USER_URL`, `ORDER_URL`, `WORKER_URL`, `GATEWAY_URL`, `KEYCLOAK_URL`.

## Results (as built, 2026-09-19)

| Check | Result |
|---|---|
| Unit + HTTP tests (lint, jest, `tsc` build) | user-service 55, order-service 80, notification-worker 65, api-gateway 61 tests pass; lint clean |
| Verifier matrix | Same 21 cases in every service (`test/token-verifier.spec.ts`) |
| Remote JWKS: warm cache, expiry, cold start, slow IdP, recovery, rotation, unknown-`kid` cooldown | 8 cases (`test/jwks-outage.spec.ts`, real HTTP server), in every service |
| Authorization matrix | Covered in each service's `test/http.spec.ts`, plus gateway `test/gateway.spec.ts` and `test/app.spec.ts` (real `AppModule` against a local JWKS server) |
| Smoke (`scripts/smoke-test.sh`, real Keycloak, whole stack) | Passes; also passes for the user-service-only pipeline shape on a freshly created volume (`down -v`, `up user-service keycloak`) |
| Cross-service tests (`node --test "tests/**/*.test.mjs"`) | 50 tests pass against the compose stack: PostgreSQL-backed conflicts, order/user lookup contract, end to end order flow for both roles, forged tokens (unknown key, `alg: none`, expired) refused by the gateway and by every service, static realm/config checks. Mutation check: switching `insert` to `save` in `UsersService` makes the "does not overwrite" test fail (with `save`, a repeated id silently updates the existing user) |
| Chaos (`tests/chaos/keycloak-outage.sh`) | Passes: warm cache keeps working; cold restart with Keycloak down stays live and ready and answers 503; recovers without restarting the service; with a 5 s key cache the service turns 503 after expiry while Keycloak is still down, with health green |
| Secret scan | gitleaks over the full git history (18 commits at the time): no leaks |
| Logs | No JWT (`eyJ`) in any container's logs after the full run; `auth.rejected reason=…` lines present |
| ID-10 | 401 from gateway and from a service echo `x-request-id` and carry `WWW-Authenticate: Bearer` |
| IDN-8 | Clean volume, repeated `up` on an existing volume, and the documented "drop the `keycloak` database" procedure all end with a healthy Keycloak and the realm imported |
| actionlint on `.github/workflows` | Clean |

Remaining gaps, stated plainly:

- The tests need the whole stack, so they are not part of the per-service unit runs; they have their own workflow. That workflow, like the others, has not run on GitHub yet (no push); it was checked with actionlint and its commands were run locally.
- The **`order.created` event schema** contract and the consumer's broker behavior (retry, DLQ, reconnect) are still verified by hand, as before this feature; the new tests only cover HTTP and identity.
- **Secret scanning in CI** (IDN-1) waits for the SAST/dependency-scan slice; gitleaks was run once locally (result above) and the static checks assert the sample env and dev realm only contain placeholder values.
- **Metrics** (IDN-7): done by the observability slice. Every refusal is counted as `auth_rejections_total{reason}` in all four services (unit-tested per service and seen in Prometheus by the pipeline test); the `AuthenticationKeysUnavailable` alert covers the Keycloak-keys case.
- Access-token expiry against real Keycloak is not exercised (5 minutes); expiry handling is covered by unit tests and by the forged expired token in the e2e test.
