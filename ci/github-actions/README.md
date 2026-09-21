# GitHub Actions

GitHub only runs workflows from `.github/workflows/`, so the executable definitions live there, not in this directory. This is a deliberate deviation from the repository layout sketched in the standards.

| Workflow | Role |
|---|---|
| `_service.yml` | Reusable pipeline shared by every service: verify (lint, test, build, dependency gate over `npm audit` with time-boxed exceptions, see [docs/security/dependency-scanning.md](../../docs/security/dependency-scanning.md)) + CodeQL SAST that fails the pipeline on high/critical findings (see [docs/security/static-analysis.md](../../docs/security/static-analysis.md)) -> build image (`<commit-sha>` tag) -> Trivy image scan that fails the pipeline on fixable high/critical vulnerabilities and high/critical secrets, exceptions in `security/image-scan/.trivyignore` (see [docs/security/image-scanning.md](../../docs/security/image-scanning.md)) -> smoke test via `docker compose` -> publish the same image to GHCR (main only, see Triggers and publishing) |
| `secret-scan.yml` | gitleaks over the whole git history on every push and pull request (no path filters), also called by `_service.yml` as the `secret-scan` job that the `image` job needs; fails on any finding (see [docs/security/secret-scanning.md](../../docs/security/secret-scanning.md)) |
| `platform-tests.yml` | Whole-stack tests (integration, contract, end to end, telemetry pipeline, outage and alert scenarios) against docker compose with the observability profile, independent of any single service |
| `user-service.yml`, `order-service.yml`, `notification-worker.yml`, `api-gateway.yml` | Thin callers: path filters and per-service inputs (`smoke-deps`, `smoke-urls`) |

## Triggers and publishing

- **Every branch:** a push to any branch runs the service pipelines (path filters kept) and `platform-tests.yml`, so a branch gets full CI feedback without a pull request. There is no `pull_request` trigger; the checks on a pull request are the runs on its head commit. They test the branch, not the merge result with `main`. Pull requests from forks get no CI (single-developer repository). If merge-result testing is wanted later, add `pull_request: branches: [main]` back with a shared concurrency group so a commit does not run twice. `workflow_dispatch` stays for manual runs.
- **Publishing is main only:** the `Log in` and `Publish` steps in `_service.yml` run only when `github.event_name == 'push' && github.ref == 'refs/heads/main'`. A branch run builds, scans and smoke tests the image but pushes nothing to GHCR, so images are built once from `main` and tagged `<commit-sha>`.
- **Concurrency:** each workflow has one group per ref. A new push to a branch cancels the previous run of that branch; on `main` runs are never cancelled, so every commit that lands on `main` is published.
- **Build cache:** `cache-from`/`cache-to` (`type=gha`) are per branch: a branch reads `main`'s cache and writes its own copy, which counts toward the 10 GB repository limit (least recently used entries are evicted first, so the worst case is a slower build, never a failed one). If that ever bites, restrict `cache-to` to `main`.
- **CodeQL** runs on branches too; results appear under the branch in the Security tab and the gate stays blocking.
- A path-filtered workflow that is skipped reports no status, so these workflows cannot be required checks in branch protection (relevant for [#16](https://github.com/veyselkaraca/platform-engineering-lab/issues/16)).

Adding a service means adding one small caller file. The smoke test runs the image under test inside the same compose stack developers use locally; only its dependencies (`smoke-deps`) are built from source and started next to it, so the published artifact is never rebuilt. The order-service and notification-worker pipelines follow an order end to end through user-service, RabbitMQ and the worker; the api-gateway pipeline runs the same flow through the gateway. Every smoke run also starts Keycloak (`keycloak` in `smoke-deps`) and uses real tokens from its dev realm; realm changes under `security/keycloak/` trigger the pipelines.

Deploy and post-deploy verification stages are added when the Kubernetes/Helm slice exists. `scripts/smoke-test.sh` is shared between CI and post-deploy checks.
