# Runbook: Keycloak unavailable or tokens rejected

Applies to the `keycloak` service and to token verification in api-gateway, user-service, order-service and notification-worker (see `docs/features/identity-keycloak`). Commands are for the local compose stack; in other environments run the same checks through that environment's tooling.

## Symptom

- Clients get `401` with a token that used to work, or `503` ("Authentication is temporarily unavailable") on every `/v1/*` call.
- Logs show `auth.rejected requestId=… reason=…` (401) or `auth.keys_unavailable requestId=… cause=…` (503).
- `/health/live` and `/health/ready` stay green on purpose: they never depend on Keycloak, so a Keycloak outage does not pull replicas out of rotation.

## 1. Which case is it?

```bash
docker compose -f infrastructure/docker/docker-compose.yml logs api-gateway user-service order-service notification-worker --no-log-prefix | grep -E "auth\.(rejected|keys_unavailable)"
```

| Log | Meaning | Action |
|---|---|---|
| `reason=missing` | No or malformed `Authorization: Bearer` header | Client bug; nothing to fix on the platform |
| `reason=expired` / `not_yet_valid` | Token lifetime (5 min) or clock skew beyond the 5 s tolerance | Get a new token; if it recurs, fix time sync between hosts |
| `reason=issuer` | Token issued for a different URL than `AUTH_ISSUER` | Client uses another Keycloak URL, or `KC_HOSTNAME` changed; the `iss` must equal `AUTH_ISSUER` |
| `reason=audience` | Token lacks `aud: platform-api` | Client is not using a client with the audience mapper |
| `reason=signature` | Unknown signing key or tampered token | If it started after a Keycloak realm/key change, see step 3 |
| `auth.keys_unavailable` | The service cannot fetch or refresh Keycloak's keys | Step 2 |

## 2. Keycloak down (503, `keys_unavailable`)

Expected behavior, no data is lost:

- A service that already fetched the keys keeps accepting valid tokens for `AUTH_JWKS_CACHE_SECONDS` (default 3600). After that, and on any cold start, it answers `503`. It never accepts a token it cannot verify.
- New logins fail; tokens already issued keep working until they expire (5 min) while the cache is warm.

Recover:

```bash
docker compose -f infrastructure/docker/docker-compose.yml ps keycloak
docker compose -f infrastructure/docker/docker-compose.yml logs keycloak --tail 50
docker compose -f infrastructure/docker/docker-compose.yml up -d --wait keycloak
```

Keycloak needs PostgreSQL (its own `keycloak` database, created by `db-init`). Once `keycloak` is healthy the services recover on their own: no restart is needed. Verify:

```bash
sh scripts/smoke-test.sh http://localhost:3001 http://localhost:3002 http://localhost:3003 http://localhost:8080
```

## 3. Keys rotated or realm re-created

A new signing key (rotation) is picked up automatically on the first token with an unknown `kid`, at most once per 30 s per service. If the realm was deleted and re-imported, it has new keys: tokens signed with the old ones fail with `reason=signature` until clients fetch new tokens; the services need no change.

Editing `security/keycloak/realm/platform-lab-dev.json` does **not** change an existing realm (import skips it). To apply it locally, follow "Changing the realm" in `security/keycloak/README.md`.

## Verifying the behavior

`sh tests/chaos/keycloak-outage.sh` stops Keycloak, checks the warm-cache and cold-start behavior above, starts it again, and checks recovery. It restarts `user-service` and always brings Keycloak back up.
