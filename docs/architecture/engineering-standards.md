# Engineering Standards

The rules every component and feature in this repository is held to. Feature issues (see [Documentation](#documentation)), the docs of the first three features (`docs/features/`) and ADRs (`docs/decisions/`) may specify details but must stay consistent with this page; where they conflict, this page wins. Concrete choices are in [ADR-001](../decisions/ADR-001-stack-and-service-responsibilities.md); the component view is in the [overview](overview.md).

## Purpose and scope

A production-like reference platform demonstrating the full lifecycle: source → build → test → static analysis → dependency/image scan → registry → deploy → health check → observe → recover/rollback. It is not a product, a cloud-provider tutorial, or a technology checklist: business logic stays minimal and exists only to exercise the platform, and every tool must solve a concrete problem in the same operational story. No employer-proprietary architecture, credentials, hostnames or data belong here.

Layers: application (gateway, two backends, an async worker, persistence, cache, messaging, authN/authZ), platform (containers, local runtime, Kubernetes-compatible deployment), delivery (CI/CD), security, observability, reliability, automation.

## Architectural principles

- **Automation first.** Anything repeated by an engineer is a candidate for automation; manual steps are for exceptions and never the normal deploy path.
- **Declarative infrastructure.** YAML, Helm, Ansible roles, pipeline definitions, version-controlled config.
- **Immutable artifacts.** Built once, promoted across environments; a deployment is traceable to a source revision.
- **Configuration is not code.** Environment differences are configuration only; no secrets in source.
- **Secure and observable by default.** Controls are on unless there is a documented reason; a component that cannot explain its behavior is not operationally complete.
- **Failure is expected.** Dependencies, containers and networks fail; failure scenarios are tested, not theoretical.
- **Idempotency**, **loose coupling** (explicit contracts, no hidden shared internals), **least privilege**, **documentation as code**.
- **Simple before complex.** Use the simplest architecture that demonstrates the behavior. Before adding infrastructure, state what problem it solves, its operational burden, how it is monitored, tested and removed.

## Technology baseline

Node.js / TypeScript / NestJS (REST); PostgreSQL, Redis, RabbitMQ; Keycloak (OIDC/OAuth2, JWT); Docker-compatible images; Kubernetes with Helm; Ansible (Bash/Python only where they materially help); at least one complete CI/CD implementation, with the same lifecycle representable in others (GitHub Actions, Azure DevOps, GitLab CI, Jenkins); SonarQube-compatible static analysis, dependency and image scanning; OpenTelemetry, Prometheus-compatible metrics, Grafana, central logs, a trace backend. Local runs may use different concrete implementations as long as the responsibilities stay intact.

The repository layout is in the [README](../../README.md#layout).

## Development standards

- **Code:** readable, modular, testable, explicit, consistent with existing patterns; no clever abstractions without benefit.
- **API design:** predictable resources, explicit validation, correct HTTP status codes, structured errors, correlation ids, health endpoints.
- **Error handling:** no silent failures, empty catch blocks, arbitrary process termination, leaked secrets, or internal exception details returned to clients.
- **Logging:** structured where practical, with enough context to correlate request, service and path. Never log passwords, access/refresh tokens, client secrets, private keys or sensitive personal data.
- **Testing layers:** unit → integration → end-to-end → smoke → optional load/resilience, proportional to risk.

## Container standards

Minimal base image, non-root, health checks, environment-driven config, no secrets in layers, reproducible builds, multi-stage where useful, exposed ports only when required. Images are tagged `<service>:<commit-sha>`; friendly tags may coexist but deployment uses the immutable one.

## Kubernetes standards

Workloads are designed for orchestration, not just packaged in a Deployment: readiness, liveness and startup probes, resource requests/limits, graceful termination, rolling updates, replica management, configuration/secret separation, service discovery, defined failure behavior.

## CI/CD and rollback

Every deployable service follows Validate → Test → Analyze → Scan → Build → Publish → Deploy → Verify. Pipelines fail on mandatory quality/security gates with understandable errors. Deployments are reproducible, traceable, automated, verifiable and reversible.

**Rollback is mandatory:** restore the previous known-good artifact and its configuration without rebuilding, validate health, then resume traffic.

## Observability

Logs, metrics and traces are first-class and a request is correlatable across services. Metrics cover request rate, error rate, latency, resource use and dependency health. Dashboards cover platform and application health. Alerts are actionable; noise without an operator action is a defect.

## Reliability

- **Availability:** stay up when non-critical dependencies degrade.
- **Timeouts:** every network dependency has an explicit one.
- **Retries:** bounded, only where safe.
- **Idempotency:** retried operations must not duplicate side effects.
- **Graceful shutdown:** services and workers handle termination signals.
- **Backpressure:** asynchronous consumers never take unlimited work.
- **Dead-letter handling:** repeatedly failing messages are recoverable without blocking healthy ones.

## Security

No credentials in Git or images; least privilege; explicit authentication boundaries and authorization rules; secure defaults; dependency hygiene and container hardening; findings visible in CI/CD.

## Identity and access

Keycloak is the identity provider. Authentication (OIDC/OAuth2 → token) and application-level authorization (roles/ownership on the API) are demonstrated separately. The platform never implements its own password storage.

## Messaging

RabbitMQ is the reference broker. Designs account for exchange/queue responsibilities, routing, consumer failure, retry, dead-lettering, idempotent processing, message correlation and observability, and keep synchronous request/response distinct from asynchronous events.

## Redis

Caching, short-lived state, rate limiting, coordination where justified. Redis is never silently the authoritative store; invalidation and consistency expectations are explicit.

## Infrastructure automation

Ansible is the reference tool. Prefer declarative modules over opaque shell; roles are idempotent, use explicit variables and inventory separation, support check mode where possible, validate before destructive operations, and keep tasks small.

## Environments and secrets

Development, test and production-like environments are separated by configuration, not by separate codebases. Secrets are external runtime inputs (environment variables, Kubernetes Secrets for demonstration, external managers); passwords, tokens, API keys, private keys and production credentials are never committed, and sample files use clearly fake values.

## Git

Commits are coherent, single-purpose changes: do not mix refactoring, features, formatting, infrastructure and docs unless inherently one change. No branch naming convention is mandated.

## Documentation

The repository must be understandable without oral explanation. Feature work is specified in a GitHub issue opened from the Feature template (`.github/ISSUE_TEMPLATE/feature.yml`), whose sections are Requirements, Design, Test plan and Operations; no per-feature files are added under `docs/`. The three features built before this rule (identity-keycloak, observability, order-notification) keep their `docs/features/<name>/` files as the record of what was built. What outlives a feature goes in the repository: decisions in `docs/decisions/`; runbooks in `docs/operations/runbooks/`. Every major component answers: why it exists, what it owns, what it depends on, what happens when it fails, how it is observed, deployed and rolled back (see the [component contract](overview.md#component-contract)).

## Definition of done

Applicable items: requirement documented, architecture impact understood, code, tests, static analysis, security checks, reproducible image, externalized config, automated deployment, health checks, logs/metrics/traces, failure behavior tested, rollback defined, docs updated. Not every item applies to a trivial change; production-impacting features address the relevant ones explicitly.

## Failure and recovery

Meaningful failure scenarios (service, database, broker or Redis down, invalid config, crash, failed deployment or health check, dependency timeout, message failure, authentication failure) are reproduced deliberately. For each, record: what failed, how it was detected, what evidence points to the root area, what automated behavior occurred, what operator action is needed, and how recovery is verified.

## Performance evidence

Measure rather than claim. When load is tested, report requests per second, error rate, average/p50/p95/p99 latency, resource use, queue depth and recovery time.

## Decision rule

When several implementations are valid, choose the one that best combines operational simplicity, reproducibility, observability, security, maintainability and demonstration value. Do not add infrastructure because it is popular or complexity to look advanced; a smaller architecture done thoroughly beats a large one done superficially.

## Working rules for contributors and coding agents

Before changing code, understand the affected service's dependencies, deployment model, configuration, observability and tests. For deployment changes consider health checks, rollout, compatibility and rollback; for security changes consider authN/authZ, secret exposure, least privilege and auditability.

Never: commit secrets, permanently disable security controls to pass tests, replace declarative automation with unexplained shell, remove health checks to hide failures, disable observability to reduce noise, or introduce hidden manual deployment steps.

## Changing these standards

Features, fixes, upgrades and refactors change implementation and the feature's issue, not this page. Changing the project's core purpose, removing an architectural responsibility, or replacing the platform model is a new project direction and needs an explicit project-level review.
