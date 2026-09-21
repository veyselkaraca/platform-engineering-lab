# Platform Engineering Lab

Production-like reference platform demonstrating the full delivery lifecycle: build, test, scan, deploy, observe, recover, roll back.

The engineering rules are in [docs/architecture/engineering-standards.md](docs/architecture/engineering-standards.md); the component view is in [docs/architecture/overview.md](docs/architecture/overview.md). Features are specified in GitHub issues (Feature template); the docs of the first three features are in [docs/features/](docs/features/).

## Layout

| Path | Responsibility |
|---|---|
| `services/` | NestJS microservices (api-gateway, user-service, order-service, notification-worker) |
| `infrastructure/` | Docker Compose, Kubernetes manifests, Helm chart, Ansible |
| `observability/` | OpenTelemetry, Prometheus, Grafana, logging, tracing |
| `security/` | Keycloak realm, SAST (CodeQL), dependency and image scanning |
| `messaging/` | RabbitMQ definitions and policies |
| `ci/` | Pipeline definitions per CI engine |
| `tests/` | Integration, e2e, contract, load, chaos |
| `scripts/` | Thin automation entry points |
| `docs/` | Architecture, operations, security, testing, ADRs, features |

Directories are placeholders (`.gitkeep`) until implemented.

## Local stack

```bash
sh scripts/bootstrap.sh    # creates the git-ignored infrastructure/docker/.env
docker compose -f infrastructure/docker/docker-compose.yml up -d --build
```

Keycloak is on `http://localhost:8081` (admin credentials in that `.env`). Add `--profile observability` for Grafana (`http://localhost:3000`), Prometheus (9090), Tempo (3200), Loki (3100) and the collector; see [observability/README.md](observability/README.md). Add `-f infrastructure/docker/docker-compose.dev.yml` for watch mode plus a debugger on 9229 (VS Code config: `.vscode/launch.json`).

## Commands

Per service, from `services/<name>`:

```bash
npm ci && npm run lint && npm test && npm run build
npx jest test/users.service.spec.ts        # single test file
npx jest -t "maps a unique-email"          # single test by name
```

Against the running stack (dev users and tokens: [security/keycloak/README.md](security/keycloak/README.md)):

| Check | Command |
|---|---|
| Smoke test | `sh scripts/smoke-test.sh http://localhost:3001 http://localhost:3002 http://localhost:3003 http://localhost:8080 [http://localhost:8081]` (positional, optional after the first; last is Keycloak) |
| Integration/contract/e2e | `node --test --test-concurrency=1 --test-reporter=spec "tests/**/*.test.mjs"` (serial: shared broker queues; leaves data behind; `dev-other` must have no user record) |
| Observability pipeline | `node --test --test-reporter=spec --test-concurrency=1 tests/observability/pipeline.obs.mjs` (stack up with the profile) |
| Chaos (disruptive: stops PostgreSQL/RabbitMQ/Keycloak, restores them) | `sh tests/chaos/keycloak-outage.sh`, and `node --test --test-reporter=spec --test-concurrency=1 tests/chaos/broker-failures.chaos.mjs tests/chaos/dependency-failures.chaos.mjs tests/chaos/database-failures.chaos.mjs` |
| Replay dead-lettered messages | `sh scripts/replay-dlq.sh` |
| Image scan | `docker run --rm -v //var/run/docker.sock:/var/run/docker.sock aquasec/trivy image --severity HIGH,CRITICAL --ignore-unfixed user-service:local` |

Runbooks: [keycloak-outage](docs/operations/runbooks/keycloak-outage.md), [notification-dlq](docs/operations/runbooks/notification-dlq.md), [service-alerts](docs/operations/runbooks/service-alerts.md). CI: `.github/workflows/` (reusable `_service.yml`, per-service callers, `platform-tests.yml`).

## Notes for contributors

- Each service keeps its own copy of `src/auth/` (verifier on `jose` **^5**, CommonJS) and `test/support/tokens.ts`; change all four together. Unit tests use locally signed tokens; auth is never switched off to pass a test.
- NestJS is pinned to 11; do not run a bare `npm install <nest-pkg>`. `build` uses `tsc` because `nest build` fails on Node 22.13.
- RabbitMQ definitions are imported by the one-shot `rabbitmq-init` service, never with `load_definitions` at boot; databases are created by `db-init`. See [messaging/rabbitmq/README.md](messaging/rabbitmq/README.md).
- `import './telemetry'` must remain the first line of each `main.ts`. Metric labels are route templates and small enums, never ids. See [observability/README.md](observability/README.md).
- Nothing may log a token or the `Authorization` header.
