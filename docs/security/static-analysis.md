# Static analysis

Decision and alternatives: [ADR-002](../decisions/ADR-002-static-analysis.md). Requirements, test plan and operations notes: [issue #2](https://github.com/veyselkaraca/platform-engineering-lab/issues/2).

> Status: decided; the Sonar job, gate script and local `quality` profile are being implemented in issue #2. Until they land, `_service.yml` still runs CodeQL only. This page describes the target and is updated when each piece lands.

## Two tools, one blocking gate

| Tool | Role | Blocks the build | Where the config lives |
|---|---|---|---|
| SonarQube (Community Build) | Quality gate: issues, ratings, security hotspots, coverage, duplication | **Yes** | `security/sonar/` |
| CodeQL | Data-flow security analysis, findings in the repository Security tab | No | `security/sast/` |

CodeQL finds injection-style flows across functions that Sonar's rules can miss; Sonar covers maintainability, coverage and duplication that CodeQL does not. They do not overlap enough to justify two gates, so only Sonar fails a build.

## Pipeline placement

Both run in `.github/workflows/_service.yml` in the Analyze stage, in parallel with `verify`, and the image build waits for them: `verify` + Sonar gate + CodeQL finished -> image build -> Trivy -> smoke test -> publish. The image is therefore never built from code that failed the gate.

Per service the Sonar job:

1. runs the unit tests with `--coverage` (`lcov` output),
2. starts a throwaway SonarQube service container and waits until it is up,
3. applies the quality gate from `security/sonar/`,
4. runs the scanner with `sonar.qualitygate.wait=true`; a failed gate fails the job.

Each service is its own Sonar project (`platform-lab-<service>`), matching the per-service pipelines. The server and its token exist only for the duration of the job; no Sonar secret is stored in the repository or in GitHub.

## Quality gate

SonarQube's built-in "Sonar way" conditions:

| Condition | Threshold |
|---|---|
| New issues | 0 (Reliability, Security and Maintainability ratings all A) |
| Security Hotspots reviewed | 100 % |
| Coverage on new code | >= 80 % |
| Duplicated lines on new code | <= 3 % |

On a throwaway server every analysis is a first analysis, so "new code" is the whole service. Consequences: a hotspot cannot be reviewed there, so any hotspot must be fixed in code; and the coverage floor applies to the whole service (currently between 81 % and 97 % statements).

When a gate fails: open the failing condition in the job log (the scanner prints the gate result and the dashboard URL of the local instance for reproducing), fix the code or add the missing tests. Do not lower a threshold or exclude a path to get green; a threshold change is a change to this page and to ADR-002.

## Running it locally

The persistent instance is in the compose stack under the `quality` profile (Sonar UI on `http://localhost:9000`, about 2 GB of memory, so it is opt-in). Commands and first-run steps are in [security/sonar/README.md](../../security/sonar/README.md).

## What this does not cover

- Dependency advisories: `npm audit --audit-level=high` in the `verify` job.
- Container image vulnerabilities: Trivy in the `image` job.
- Runtime and cross-service behavior: the platform tests and the smoke test.
- Branch and pull-request analysis, history and trends: not available in Community Build with a throwaway server.
