# GitHub Actions

GitHub only runs workflows from `.github/workflows/`, so the executable definitions live there, not in this directory. This is a deliberate deviation from the repository layout sketched in the standards.

| Workflow | Role |
|---|---|
| `_service.yml` | Reusable pipeline shared by every service: verify (lint, test, build, `npm audit`) + CodeQL SAST -> build image (`<commit-sha>` tag) -> Trivy scan -> smoke test via `docker compose` -> publish the same image to GHCR (main only) |
| `platform-tests.yml` | Whole-stack tests (integration, contract, end to end, telemetry pipeline, outage and alert scenarios) against docker compose with the observability profile, independent of any single service |
| `user-service.yml`, `order-service.yml`, `notification-worker.yml`, `api-gateway.yml` | Thin callers: path filters and per-service inputs (`smoke-deps`, `smoke-urls`) |

Adding a service means adding one small caller file. The smoke test runs the image under test inside the same compose stack developers use locally; only its dependencies (`smoke-deps`) are built from source and started next to it, so the published artifact is never rebuilt. The order-service and notification-worker pipelines follow an order end to end through user-service, RabbitMQ and the worker; the api-gateway pipeline runs the same flow through the gateway. Every smoke run also starts Keycloak (`keycloak` in `smoke-deps`) and uses real tokens from its dev realm; realm changes under `security/keycloak/` trigger the pipelines.

Deploy and post-deploy verification stages are added when the Kubernetes/Helm slice exists. `scripts/smoke-test.sh` is shared between CI and post-deploy checks.
