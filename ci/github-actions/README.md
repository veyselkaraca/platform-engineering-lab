# GitHub Actions

GitHub only runs workflows from `.github/workflows/`, so the executable definitions live there, not in this directory. This is a deliberate deviation from the AGENTS.md section 10 sketch.

| Workflow | Role |
|---|---|
| `_service.yml` | Reusable pipeline shared by every service: verify (lint, test, build, `npm audit`) + CodeQL SAST -> build image (`<commit-sha>` tag) -> Trivy scan -> smoke test via `docker compose` -> publish the same image to GHCR (main only) |
| `user-service.yml`, `order-service.yml` | Thin callers: path filters and per-service inputs (`smoke-deps`, `smoke-urls`) |

Adding a service means adding one small caller file. The smoke test runs the image under test inside the same compose stack developers use locally; only its dependencies are built from source, so the published artifact is never rebuilt.

Deploy and post-deploy verification stages are added when the Kubernetes/Helm slice exists. `scripts/smoke-test.sh` is shared between CI and post-deploy checks.
