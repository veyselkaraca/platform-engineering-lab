# Secret scan (blocking)

[gitleaks](https://github.com/gitleaks/gitleaks) scans the whole git history on every push and pull request (`.github/workflows/secret-scan.yml`), and the image build of every service pipeline waits for it. A finding fails the pipeline. How it works and what to do when it fails: [docs/security/secret-scanning.md](../../docs/security/secret-scanning.md).

| File | Purpose |
|---|---|
| `scan.sh` | The history scan (default) and the `canary` check that the config still detects a leak. Runs gitleaks from a pinned Docker image |
| `gitleaks.toml` | Default rules plus an allow-list, empty today. An entry is one path and one regex, only for a fake value |

Changes under this folder trigger the service pipelines.

```bash
sh security/secret-scan/scan.sh          # same as the pipeline
sh security/secret-scan/scan.sh canary
```
