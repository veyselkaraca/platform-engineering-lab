# CodeQL (second layer, non-blocking)

CodeQL runs in `.github/workflows/_service.yml` and reports data-flow findings to the repository Security tab. It does not fail the build: the single blocking gate is SonarQube (see [security/sonar](../sonar/README.md)). Rationale: [ADR-002](../../docs/decisions/ADR-002-static-analysis.md). Overview: [docs/security/static-analysis.md](../../docs/security/static-analysis.md).

`codeql-config.yml` is passed to the workflow's `config-file` input: the `security-extended` query suite, ignoring `node_modules`, `dist` and `coverage`. Tests are analyzed too. Changing the suite or the ignored paths is a change to that file, not to the workflow.
