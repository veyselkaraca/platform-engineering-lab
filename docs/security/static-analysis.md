# Static analysis

Decision and alternatives: [ADR-002](../decisions/ADR-002-static-analysis.md). Requirements, test plan and operations notes: [issue #2](https://github.com/veyselkaraca/platform-engineering-lab/issues/2).

## What runs

CodeQL (`security-extended` query suite, JavaScript/TypeScript) runs in its own workflow, `.github/workflows/codeql.yml`: on every push (no path filter, unlike the service pipelines), on a weekly schedule (`0 6 * * 1`, so new CodeQL queries also report on code nobody touched), on `workflow_dispatch`, and as a `workflow_call` from the `codeql` job of `.github/workflows/_service.yml` (in parallel with `verify`), which is how each service pipeline still waits on the same-commit result. Findings are uploaded to the repository Security tab and any high or critical one fails whichever run found it:

`verify` + `codeql` + `secret-scan` -> image build -> Trivy -> smoke test -> publish

Splitting the trigger out this way (#29) is what lets a change under `tests/**` — outside every service pipeline's path filter — still get a CodeQL run, without adding `tests/**` to those filters and rebuilding all four service images for a test-only change. The cost: a push that also triggers one or more service pipelines (e.g. a `services/user-service/**` change) now gets more than one CodeQL run on the same commit — one from the standalone `push` trigger and one per triggered pipeline's `workflow_call`. This is the same trade-off already accepted for `secret-scan.yml`; CodeQL analyzes the whole repository regardless of which service changed, so this was already redundant across services before #29, just not across the extra standalone run.

The three scanners in the pipeline fail at the same level:

| Check | Where | Fails on |
|---|---|---|
| Dependency advisories | `verify`: `npm audit --json` + `security/dependency-scan/gate.mjs` ([details](dependency-scanning.md)) | fixable high, critical, unless excepted |
| Static analysis (SAST) | `codeql`: CodeQL + `security/sast/gate.mjs` | security-severity >= 7.0 (high, critical) |
| Image vulnerabilities and secrets | `image`: Trivy `--severity HIGH,CRITICAL --ignore-unfixed` ([details](image-scanning.md)) | fixable high, critical; high/critical secrets |

## The gate

The `analyze` action uploads results but never fails on them. The job therefore writes SARIF (`output: sarif-results`) and runs `node security/sast/gate.mjs sarif-results/*.sarif`:

- It counts results that are not suppressed and whose rule has a `security-severity` of at least 7.0 (override for experiments with `CODEQL_FAIL_SEVERITY`); it prints each one as `file:line rule (score) message` and exits 1.
- Medium and low findings, and rules with no security score, stay visible in the Security tab and do not fail the build.
- It fails closed: no SARIF file, or one that cannot be parsed, exits 1.
- The job runs `node --test security/sast/gate.test.mjs` first: blocking and non-blocking scores, rules read from the driver and from query-pack extensions, suppressions, the threshold override, and the exit codes of the command line.

CodeQL analyzes the whole repository on every run, so a blocking finding in one service fails every run until it is fixed: the standalone `push` run, and every service pipeline that runs.

## When the gate fails

1. Read the `Fail on high/critical findings` step: it lists `file:line`, the rule and its score. The same alert is in the Security tab (Code scanning) with the data-flow path.
2. Fix the code. If the alert is a false positive, suppress it in code with a `// codeql[<rule-id>]` comment that says why, so the decision is reviewed in the diff.
3. Do not lower the threshold or exclude a path to get green; a threshold change is a change to this page and to ADR-002.

## Configuration

| File | Purpose |
|---|---|
| `security/sast/codeql-config.yml` | Query suite (`security-extended`) and ignored paths (`node_modules`, `dist`, `coverage`); passed as `config-file` to the CodeQL `init` step |
| `security/sast/gate.mjs` | The gate |
| `security/sast/gate.test.mjs` | Test of the gate: `node --test security/sast/gate.test.mjs` |

Changes under `security/sast/` trigger the service pipelines.

## What this does not cover

- Coverage, duplication and maintainability gates: not provided by CodeQL. SonarQube, which does, is set up in a separate repository (ADR-002).
- Runtime and cross-service behavior: the platform tests and the smoke test.
- Findings CodeQL has no query for; it is one layer, alongside dependency and image scanning.
