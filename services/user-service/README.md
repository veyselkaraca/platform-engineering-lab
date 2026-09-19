# user-service

Owns user records (PostgreSQL, database `user_service`). See [ADR-001](../../docs/decisions/ADR-001-stack-and-service-responsibilities.md) and the [order-notification feature](../../docs/features/order-notification/REQUIREMENTS.md).

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/users` | **admin.** `{id, email, name}` → 201, where `id` is the user's Keycloak `sub` (users are provisioned in the realm; this registers the matching record). Duplicate id → 409, duplicate email → 409 (different messages); validation → 400 |
| GET | `/v1/users/:id` | **the user themself or an admin.** 200 / 404; someone else's id → 403; non-UUID → 400 |
| GET | `/health/live` | Process is up, no dependencies |
| GET | `/health/ready` | PostgreSQL reachable (2s timeout) |

All `/v1` routes need a valid Keycloak bearer token (`401` otherwise, `403` for a missing role or someone else's id). The token `sub` **is** the `userId`. See [identity-keycloak](../../docs/features/identity-keycloak/DESIGN.md); the verifier is in `src/auth/`. A service that cannot obtain Keycloak's keys answers `503` (fail closed) but stays live and ready.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string; startup fails if missing |
| `PORT` | `3000` | Listen port |
| `AUTH_ISSUER` | required | Expected token `iss` (Keycloak realm URL as clients see it) |
| `AUTH_AUDIENCE` | required | Required token `aud` (`platform-api`) |
| `AUTH_JWKS_URL` | required | Where Keycloak's public signing keys are fetched from |
| `AUTH_JWKS_TIMEOUT_MS` | `2000` | Timeout of the key fetch |
| `AUTH_JWKS_CACHE_SECONDS` | `3600` | How long fetched keys are trusted; after that (with Keycloak down) requests get 503 |
| `AUTH_CLOCK_TOLERANCE_SECONDS` | `5` | Accepted clock skew, max 60 |
| `LOG_LEVEL` | `info` | pino level |

Sample fake values: `.env.example`. Migrations run automatically at startup.

## Commands

```bash
npm ci
npm run lint
npm test
npm run build
```

Full stack with PostgreSQL (from the repo root):

```bash
sh scripts/bootstrap.sh
docker compose -f infrastructure/docker/docker-compose.yml up -d --build
```

## Debugging in Docker (VS Code)

Runs the service in the image's Node version (22 LTS), independent of the host Node.

```bash
docker compose -f infrastructure/docker/docker-compose.yml -f infrastructure/docker/docker-compose.dev.yml up --build
```

Then start **user-service: attach (docker)** from the VS Code Run and Debug panel. Source is bind-mounted with watch mode, so edits reload the service.

## Operational notes

- **Why it exists / owns:** user records; nothing else writes to its database.
- **Depends on:** PostgreSQL (hard). Keycloak's public keys for token checks (soft: cached, not in readiness). **On failure:** readiness fails and traffic is removed; liveness stays green so the pod is not restarted for a DB outage. Requests meanwhile get a generic `503` (`database.unavailable` is logged with the request id), with a 2 s connect timeout; verified in `tests/chaos/database-failures.chaos.mjs`. Keycloak down -> `503` on `/v1` once the key cache is cold or expired.
- **Observed:** JSON logs (pino) with `req.id` = `x-request-id` (reused from the caller or generated, echoed in the response); probe requests are not logged; `authorization`/`cookie` headers are redacted (a test asserts tokens never reach the logs); rejected requests log `auth.rejected` / `auth.forbidden` with the request id and reason. OpenTelemetry (`src/telemetry.ts`): traces, HTTP and runtime metrics, auth refusals by reason, database-unavailable responses; every log line carries `trace_id`/`span_id`. Dashboards and alerts: `observability/`.
- **Image:** multi-stage, non-root (`node` user), `HEALTHCHECK` on `/health/live`, revision label from `GIT_SHA`. Tag as `user-service:<commit-sha>`. npm/npx/corepack are removed from the runtime stage (the app runs with plain `node`); this cleared Trivy findings that came from npm's own bundled packages in the base image.
- **CI:** `.github/workflows/user-service.yml` (see `ci/github-actions/README.md`). Post-deploy check: `sh scripts/smoke-test.sh <base-url>` (needs Keycloak for tokens).
- **Rollback:** redeploy the previous image tag. Migrations must stay backward compatible with the previous release.
- **Shutdown:** SIGTERM drains connections and closes the DB pool.

## Dependency notes

NestJS is pinned to the 11 line: 12 is ESM-only and this service is CommonJS. `multer` is overridden to a patched release (transitive via `@nestjs/platform-express`; file uploads are not used). Re-evaluate both when moving to Nest 12.
