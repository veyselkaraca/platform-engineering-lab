# SonarQube (quality gate)

The blocking static analysis gate of every service pipeline. Why and how: [ADR-002](../../docs/decisions/ADR-002-static-analysis.md) and [docs/security/static-analysis.md](../../docs/security/static-analysis.md).

This directory holds what the pipeline and the local instance share: the scanner properties per service, the quality gate definition and the script that applies it. Nothing is configured by hand in the Sonar UI. Implementation is tracked in [issue #2](https://github.com/veyselkaraca/platform-engineering-lab/issues/2); until it lands, this directory only documents the intended contents.

The local instance is the `quality` profile of `infrastructure/docker/docker-compose.yml` (UI on `http://localhost:9000`). Its admin password and tokens are runtime inputs; no Sonar credential is committed.
