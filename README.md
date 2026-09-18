# Platform Engineering Lab

Production-like reference platform demonstrating the full delivery lifecycle: build, test, scan, deploy, observe, recover, roll back.

The engineering charter is [AGENTS.md](AGENTS.md). Feature-level docs live in [docs/features/](docs/features/).

## Layout

| Path | Responsibility |
|---|---|
| `services/` | NestJS microservices (api-gateway, user-service, order-service, notification-worker) |
| `infrastructure/` | Docker Compose, Kubernetes manifests, Helm chart, Ansible |
| `observability/` | OpenTelemetry, Prometheus, Grafana, logging, tracing |
| `security/` | Keycloak realm, Sonar, SAST, dependency and image scanning |
| `messaging/` | RabbitMQ definitions and policies |
| `ci/` | Pipeline definitions per CI engine |
| `tests/` | Integration, e2e, contract, load, chaos |
| `scripts/` | Thin automation entry points |
| `docs/` | Architecture, operations, security, testing, ADRs, features |

Directories are placeholders (`.gitkeep`) until implemented.
