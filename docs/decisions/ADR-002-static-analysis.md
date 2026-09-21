# ADR-002: Static analysis with CodeQL as a blocking gate

- Status: Accepted
- Scope: Implementation decision under the [technology baseline](../architecture/engineering-standards.md#technology-baseline) (static analysis). Tracked in [issue #2](https://github.com/veyselkaraca/platform-engineering-lab/issues/2).

## Context

The service pipelines ran CodeQL as their only static analysis step. That step uploads findings to GitHub code scanning but never fails a build, and no severity threshold was ever agreed. The standards list static analysis as a pipeline stage; a stage that cannot fail is not a control.

SonarQube was evaluated as the gate (a throwaway server per pipeline run plus a local instance in the compose stack) and prototyped. It works, but it adds a server to operate (about 2 GB and a start-up wait per run, a database, credentials, a token) for a lab whose point in this repository is the delivery pipeline. Setting SonarQube up properly is handled in a separate repository, so it is out of scope here.

## Decision

- **CodeQL is the static analysis step of every service pipeline, and it blocks.** It runs natively in GitHub Actions with no infrastructure of our own, and findings still go to the repository Security tab.
- **The gate:** the pipeline fails when CodeQL reports an unsuppressed finding whose rule has a security-severity of **7.0 or higher** (high and critical). This is the same bar as `npm audit --audit-level=high` and the Trivy scan (`HIGH,CRITICAL`), so all three scanners in the pipeline fail at the same level. Medium and low findings, and rules without a security score, are visible in the Security tab but do not fail the build.
- **How it is enforced:** the `analyze` action uploads results but never fails on them, so it writes SARIF to `sarif-results/` and `security/sast/gate.mjs` reads it and exits non-zero on a blocking finding. The gate fails closed: no SARIF file, or an unreadable one, fails the job. The gate script has its own unit test (`security/sast/gate.test.mjs`), which the pipeline runs before using it.
- **Configuration is files:** the query suite (`security-extended`) and ignored paths are in `security/sast/codeql-config.yml`; the threshold is a constant in the workflow-visible script (override with `CODEQL_FAIL_SEVERITY`). Nothing is set by hand in a UI.
- The image build waits for the CodeQL job, so no image is built from code that failed the gate.
- **Handling a finding:** fix the code. A false positive is suppressed in code with a justification (`// codeql[<rule-id>]` comment) so the decision is reviewed in the diff; the threshold is never lowered and a path is never excluded to get green.

## Consequences

- No new component to run: the cost is the analysis time in the pipeline. CodeQL analyzes the whole repository in every service pipeline, so a blocking finding in one service fails every pipeline that runs until it is fixed.
- CodeQL has no coverage, duplication or maintainability signal. Coverage stays visible in the unit test run; a quality gate of that kind is what the SonarQube work in the other repository would add.
- The threshold is one number in one script, recorded here and in [static analysis](../security/static-analysis.md); changing it means updating both.
- The baseline in the engineering standards names SonarQube-compatible analysis; this repository deliberately uses CodeQL instead and the standards page is worded accordingly.

## Alternatives considered

- **SonarQube (throwaway server in CI, persistent local instance):** gives a quality gate with coverage and duplication, and demonstrates operating the platform; prototyped and verified, then removed because it is a project of its own and moves to a separate repository. The prototype is in the git history (commit `c24540d`, reverted afterwards).
- **SonarCloud:** no server to run, but a third-party service with a stored token, and the same scope question as above.
- **CodeQL non-blocking, gate via a repository ruleset ("code scanning results" required check):** no script, but the rule lives in repository settings, not in version control, and cannot be reviewed or tested; rejected in favor of the script.
- **Two blocking gates (Sonar and CodeQL):** doubles the places a build can fail for little added assurance; rejected.
