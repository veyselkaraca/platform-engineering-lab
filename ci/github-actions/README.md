# GitHub Actions

GitHub only runs workflows from `.github/workflows/`, so the executable definitions live there, not in this directory. This is a deliberate deviation from the AGENTS.md §10 sketch.

| Workflow | Lifecycle |
|---|---|
| `.github/workflows/user-service.yml` | verify (lint, test, build, `npm audit`) + CodeQL SAST -> build image (`<commit-sha>` tag) -> Trivy scan -> smoke test against real PostgreSQL -> publish the same image to GHCR (main only) |

Deploy and post-deploy verification stages are added when the Kubernetes/Helm slice exists. `scripts/smoke-test.sh` is shared between CI and post-deploy checks.
