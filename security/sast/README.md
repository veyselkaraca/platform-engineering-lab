# CodeQL (second layer, non-blocking)

CodeQL runs in `.github/workflows/_service.yml` and reports data-flow findings to the repository Security tab. It does not fail the build: the single blocking gate is SonarQube (see [security/sonar](../sonar/README.md)). Rationale: [ADR-002](../../docs/decisions/ADR-002-static-analysis.md). Overview: [docs/security/static-analysis.md](../../docs/security/static-analysis.md).

The CodeQL configuration file (`codeql-config.yml`: query suite and paths to ignore, such as `node_modules` and `dist`) lives here and is referenced by the workflow's `config-file` input. Implementation is tracked in [issue #2](https://github.com/veyselkaraca/platform-engineering-lab/issues/2).
