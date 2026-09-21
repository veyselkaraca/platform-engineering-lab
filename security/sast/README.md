# CodeQL (SAST, blocking)

CodeQL is the static analysis step of every service pipeline (`.github/workflows/_service.yml`, job `codeql`). It reports to the repository Security tab and fails the pipeline on any unsuppressed finding with a security-severity of 7.0 or higher (high, critical). Rationale: [ADR-002](../../docs/decisions/ADR-002-static-analysis.md). How it works and what to do when it fails: [docs/security/static-analysis.md](../../docs/security/static-analysis.md).

| File | Purpose |
|---|---|
| `codeql-config.yml` | Query suite (`security-extended`) and ignored paths; the workflow's `config-file` |
| `gate.mjs` | Reads the SARIF that `analyze` writes and exits 1 on a blocking finding (no dependencies, fails closed) |
| `gate.test.mjs` | Test of the gate; the pipeline runs it before the gate |

```bash
node --test security/sast/gate.test.mjs
```
