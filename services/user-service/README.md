# user-service

Owns user records (PostgreSQL, database `user_service`). See [ADR-001](../../docs/decisions/ADR-001-stack-and-service-responsibilities.md) and the [order-notification feature](../../docs/features/order-notification/REQUIREMENTS.md).

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/users` | `{email, name}` → 201; duplicate email → 409; validation → 400 |
| GET | `/v1/users/:id` | 200 / 404; non-UUID → 400 |
| GET | `/health/live` | Process is up, no dependencies |
| GET | `/health/ready` | PostgreSQL reachable (2s timeout) |

AuthN/AuthZ (admin / self) is not implemented yet; it arrives with the Keycloak slice. Do not expose this service directly until then.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string; startup fails if missing |
| `PORT` | `3000` | Listen port |
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
- **Depends on:** PostgreSQL. **On failure:** readiness fails and traffic is removed; liveness stays green so the pod is not restarted for a DB outage.
- **Observed:** JSON logs (pino) with `req.id` = `x-request-id` (reused from the caller or generated, echoed in the response); probe requests are not logged; `authorization`/`cookie` headers are redacted. Metrics and traces arrive with the observability slice.
- **Image:** multi-stage, non-root (`node` user), `HEALTHCHECK` on `/health/live`, revision label from `GIT_SHA`. Tag as `user-service:<commit-sha>`. npm/npx/corepack are removed from the runtime stage (the app runs with plain `node`); this cleared Trivy findings that came from npm's own bundled packages in the base image.
- **CI:** `.github/workflows/user-service.yml` (see `ci/github-actions/README.md`). Post-deploy check: `sh scripts/smoke-test.sh <base-url>`.
- **Rollback:** redeploy the previous image tag. Migrations must stay backward compatible with the previous release.
- **Shutdown:** SIGTERM drains connections and closes the DB pool.

## Dependency notes

NestJS is pinned to the 11 line: 12 is ESM-only and this service is CommonJS. `multer` is overridden to a patched release (transitive via `@nestjs/platform-express`; file uploads are not used). Re-evaluate both when moving to Nest 12.
