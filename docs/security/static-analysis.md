# Static analysis

Decision and alternatives: [ADR-002](../decisions/ADR-002-static-analysis.md). Requirements, test plan and operations notes: [issue #2](https://github.com/veyselkaraca/platform-engineering-lab/issues/2).

## Two tools, one blocking gate

| Tool | Role | Blocks the build | Where the config lives |
|---|---|---|---|
| SonarQube (Community Build) | Quality gate: issues, ratings, security hotspots, coverage, duplication | **Yes** | `security/sonar/` |
| CodeQL | Data-flow security analysis, findings in the repository Security tab | No | `security/sast/` |

CodeQL finds injection-style flows across functions that Sonar's rules can miss; Sonar covers maintainability, coverage and duplication that CodeQL does not. They do not overlap enough to justify two gates, so only Sonar fails a build.

## Pipeline placement

Both run in `.github/workflows/_service.yml` in the Analyze stage, in parallel with `verify`, and the image build waits for all three: `verify` + `sonar` gate + `codeql` finished -> image build -> Trivy -> smoke test -> publish. The image is therefore never built from code that failed the gate.

Per service the Sonar job:

1. runs the unit tests with `--coverage` (`lcov` output),
2. starts SonarQube from the compose `quality` profile on the runner and waits until it is healthy,
3. runs `security/sonar/analyze.sh <service>`: sets the admin password (`SONAR_ADMIN_PASSWORD` from the bootstrapped `.env`, a fake lab value), checks that the default gate is still the built-in Sonar way, creates a fresh scan token, and runs the scanner (`@sonar/scan`, no Java needed) with `sonar.qualitygate.wait=true`; a failed gate makes the script, and so the job, exit non-zero.

Each service is its own Sonar project (`platform-lab-<service>`), matching the per-service pipelines. The server and its token exist only for the duration of the job; no Sonar secret is stored in the repository or in GitHub. The gate is Sonar's built-in one, which cannot be edited, so there is no gate definition file: the script refuses to scan if the default gate was swapped, which is what keeps the gate under version control.

## Quality gate

SonarQube's built-in "Sonar way" conditions:

| Condition | Threshold |
|---|---|
| New issues | 0 (Reliability, Security and Maintainability ratings all A) |
| Security Hotspots reviewed | 100 % |
| Coverage on new code | >= 80 % |
| Duplicated lines on new code | <= 3 % |

On a throwaway server every analysis is a first analysis, so "new code" is the whole service. Consequences: a hotspot cannot be reviewed there, so any hotspot must be fixed in code; and the coverage floor applies to the whole service (currently between 81 % and 97 % statements).

When a gate fails: the scanner log prints `QUALITY GATE STATUS: FAILED`. Reproduce it locally (below), open the dashboard of that project (`http://localhost:9000/dashboard?id=platform-lab-<service>`) to see the failing condition, and fix the code or add the missing tests. Do not lower a threshold or exclude a path to get green; a threshold change is a change to this page and to ADR-002.

## Running it locally

The persistent instance is in the compose stack under the `quality` profile (Sonar UI on `http://localhost:9000`, about 2 GB of memory, so it is opt-in). Commands are in [security/sonar/README.md](../../security/sonar/README.md).

## Verified behavior

Run locally against the compose instance (the same script and gate as CI): all four services pass the gate (coverage 81-97 %); adding a hard-coded credential and an identical-operands bug to `user-service` made `analyze.sh` exit 1 with `QUALITY GATE STATUS: FAILED` (condition: new violations), and reverting it passed again. The scanner and gate script ran identically on a fresh server (default `admin/admin`) and on a re-run (idempotent).

## What this does not cover

- Dependency advisories: `npm audit --audit-level=high` in the `verify` job.
- Container image vulnerabilities: Trivy in the `image` job.
- Runtime and cross-service behavior: the platform tests and the smoke test.
- Branch and pull-request analysis, history and trends: not available in Community Build with a throwaway server.
