# SonarQube (quality gate)

The blocking static analysis gate of every service pipeline. Why and how: [ADR-002](../../docs/decisions/ADR-002-static-analysis.md) and [docs/security/static-analysis.md](../../docs/security/static-analysis.md).

| File | Purpose |
|---|---|
| `analyze.sh` | Runs the scan for one service against the compose SonarQube and exits non-zero when the quality gate fails. Used by CI and locally. |
| `sonar-project.properties` | Scanner settings shared by all services (sources, tests, exclusions, coverage report path) |

The gate is the built-in "Sonar way"; `analyze.sh` refuses to scan if the default gate was changed. Nothing is configured by hand in the Sonar UI.

## Run it locally

From the repo root, with the local stack's `.env` present (`sh scripts/bootstrap.sh`):

```bash
docker compose -f infrastructure/docker/docker-compose.yml --profile quality up -d --wait sonarqube
cd services/user-service && npm test -- --coverage --coverageReporters=lcov && cd ../..
sh security/sonar/analyze.sh user-service
```

Dashboard: `http://localhost:9000`, login `admin` with `SONAR_ADMIN_PASSWORD` from `infrastructure/docker/.env`; projects are named `platform-lab-<service>`. The server needs about 2 GB and takes about a minute to become healthy. The scanner writes a git-ignored `.scannerwork/` directory in the service.

The admin password (a fake lab value from `.env.example`, which satisfies SonarQube's password policy) and the scan token are runtime inputs: the token is created per run and never printed. If a service scan fails with "cannot authenticate", the server volume was initialized with another password: `docker volume rm platform-lab_sonarqube-data` and start it again.
