# Secret scanning

Requirements: [issue #5](https://github.com/veyselkaraca/platform-engineering-lab/issues/5), platform requirement IDN-1 ([identity requirements](../features/identity-keycloak/REQUIREMENTS.md)). Sibling checks: [static analysis](static-analysis.md), [dependency scanning](dependency-scanning.md), [image scanning](image-scanning.md).

## What runs

[gitleaks](https://github.com/gitleaks/gitleaks) scans the **whole git history** (not only the latest commit: a secret removed in a later commit is still leaked). The workflow `.github/workflows/secret-scan.yml` runs on every push (all branches), every pull request and on demand, without path filters. Its two steps run `security/secret-scan/scan.sh`, so CI and a laptop run the same commands:

1. `scan.sh canary` feeds a leak-shaped token and a placeholder to gitleaks with the repository config. The job fails if the token is not detected or the placeholder is flagged, so a broken or emptied config cannot pass silently.
2. `scan.sh` scans the history. Any finding, and any failure to run, exits non-zero and fails the job.

The `secret-scan` job of `.github/workflows/_service.yml` calls the same workflow and the `image` job needs it, so a leak also stops the image from being built and published:

`verify` + `codeql` + `secret-scan` -> image build -> Trivy -> smoke test -> publish

The Trivy image scan (`scanners: vuln,secret`) is a separate check on what is inside the built image; gitleaks covers what is in git.

| Setting | Value | Why |
|---|---|---|
| Image | `zricethezav/gitleaks:v8.30.1` in `scan.sh` | Pinned: gitleaks adds rules between releases and a new rule can fail an unchanged repository. Bump it deliberately, in its own change |
| Rules | Default rule set (`useDefault = true` in `security/secret-scan/gitleaks.toml`) | No custom rules; nothing is switched off |
| Output | `--redact` | A found secret is not printed into the public log |
| Depth | Full history (`fetch-depth: 0`) | See above; 57 commits scan in about 3 seconds |

Not covered: secrets outside git (a developer's `.env`, which is git-ignored, or container logs), a secret shaped so that no default rule matches, and a secret pushed to a branch of a fork that never opens a pull request. GitHub's own secret scanning and push protection are switched off on this repository; enabling them is a repository setting, not part of this change.

## Allow-list

Nothing is allow-listed. The sample environment file (`infrastructure/docker/.env.example`, `change-me-lab-only`) and the dev realm (`security/keycloak/realm/platform-lab-dev.json`, `dev-*-fake-password`) are not flagged by any default rule: the baseline scan over the full history reported no leak without any allow-list. An entry that never matches cannot be tested, so none was added. What keeps those values honest is the static test `tests/integration/identity-config.test.mjs` (IDN-1: every credential there must say it is fake) plus this scan, which would flag a value that looks real.

If a rule flags a fake value one day, add one entry to `security/secret-scan/gitleaks.toml`, in a reviewed change:

```toml
[[allowlists]]
description = "<why this is a fake value>"
condition = "AND"
paths = ['''^infrastructure/docker/\.env\.example$''']
regexes = ['''change-me-lab-only''']
```

- One file and one value pattern per entry (`condition = "AND"` requires both), so a real secret in the same file is still found. Never allow-list a directory, a rule or a commit range.
- Only clearly fake values qualify. There is no expiry, unlike the vulnerability exceptions, because a fake value does not become dangerous later.
- Run `sh security/secret-scan/scan.sh canary` afterwards: it must still detect a leak.

## When the scan fails

1. Read the `Scan the git history` step: it shows the rule, the file, the commit and the author. The value is redacted.
2. **It is a real secret:** treat it as leaked. Rotate or revoke it first (removing it from git does not undo the exposure), then remove it from the code and load it from the environment. Rewriting history is optional and only after rotation; the finding stays visible in any clone and fork made before. Never allow-list it.
3. **It is a fake value:** add an allow-list entry as described above.
4. **The canary step failed:** the config or the pinned image changed so that detection no longer works. Fix the config; do not remove the step.
5. **The step failed without a finding** (Docker Hub pull limit or outage, `failed to pull` in the log): an infrastructure failure. Re-run the job. Do not skip the scan to publish.

Reproduce locally (needs only Docker; off the corporate network Docker Hub may be unreachable, see CLAUDE.md):

```bash
sh security/secret-scan/scan.sh          # history scan
sh security/secret-scan/scan.sh canary   # config check
```

## Configuration

| File | Purpose |
|---|---|
| `.github/workflows/secret-scan.yml` | The workflow: every push and PR, also callable |
| `.github/workflows/_service.yml` (`secret-scan`) | Makes the scan a prerequisite of the image build and publish |
| `security/secret-scan/gitleaks.toml` | Default rules and the (empty) allow-list |
| `security/secret-scan/scan.sh` | The scan and the canary check, pinned image |
