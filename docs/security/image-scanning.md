# Image scanning

Requirements: [issue #4](https://github.com/veyselkaraca/platform-engineering-lab/issues/4). Sibling checks: [dependency scanning](dependency-scanning.md), [static analysis](static-analysis.md), [SBOM](sbom.md).

## What runs

The `image` job of `.github/workflows/_service.yml` builds `<service>:<commit-sha>` once and scans that exact image with Trivy (`aquasecurity/trivy-action`) before the smoke test and before publish:

`verify` + `codeql` + `secret-scan` -> image build -> **Trivy** -> smoke test -> publish

The same image that passed is the one pushed; it is never rebuilt after the scan.

| Setting | Value | Why |
|---|---|---|
| `scanners` | `vuln,secret` | OS and library vulnerabilities, and secrets baked into the image (a platform rule: secrets are never in images). Set explicitly so a change of the action's default cannot silently drop one |
| `severity` | `HIGH,CRITICAL` | Same bar as `npm audit --audit-level=high` and CodeQL security-severity >= 7.0 |
| `ignore-unfixed` | `true` | A finding with no fixed version cannot be acted on; it does not fail the build |
| `trivyignores` | `security/image-scan/.trivyignore` | Accepted findings, see below |
| `exit-code` | `1` | The step is the gate: findings fail the job |

Not covered: MEDIUM/LOW findings and unfixed ones (not blocking, not reported by this step), misconfiguration scanning. An SBOM of the same image is generated separately, see [sbom.md](sbom.md). The scan sees what is in the image at build time; a vulnerability published later is only found the next time a pipeline runs.

## When the gate fails

1. Read the `Scan image` step: it lists the package, installed and fixed version, the CVE id and the layer (OS package or `node_modules`).
2. **OS package** (base image): rebuild against a newer `node:22-...` base tag; if the runtime stage adds no tools of its own, remove what is not needed instead (npm, npx and corepack are already removed from the runtime stage of every service, which cleared the findings that came from npm's own bundled packages, see [services/user-service/README.md](../../services/user-service/README.md)).
3. **Library** (`node_modules`): bump the dependency in the service (`package-lock.json`); the dependency gate in `verify` normally reports the same advisory earlier, with the same fix.
4. **Secret**: remove it from the image and from the build context, and rotate it; treat it as leaked. Never add it to the ignore file.
5. If it cannot be fixed yet, add an exception (next section) in a reviewed change. Do not lower `severity`, drop `exit-code`, or skip the step.

Reproduce locally (needs the DB download to work, see below):

```bash
docker build -t user-service:local services/user-service
docker run --rm -v //var/run/docker.sock:/var/run/docker.sock -v "$PWD/security/image-scan:/ignore:ro" \
  aquasec/trivy image --severity HIGH,CRITICAL --ignore-unfixed --scanners vuln,secret \
  --ignorefile /ignore/.trivyignore user-service:local
```

## Exceptions

`security/image-scan/.trivyignore` is empty by default and applies to all services. One entry per finding, in a reviewed change, always as a pair:

```
# <why it does not apply or cannot be fixed yet>, reviewed by <who> on <YYYY-MM-DD>
CVE-YYYY-NNNNN exp:YYYY-MM-DD
```

- The comment line is the reason; an entry without one is not accepted in review.
- `exp:` is at most 90 days after the day the entry is added (same limit as the dependency exceptions). After that date Trivy stops ignoring the id and the pipeline fails again, so a stale entry cannot stay forever. Remove the entry when the fix ships.
- Secrets are not excepted; fix them.
- A production dependency excepted in `security/dependency-scan/exceptions.json` needs an entry here for the same advisory with the same expiry (see [dependency-scanning.md](dependency-scanning.md)). Use the CVE id here and the GHSA id there. Dev-only dependencies are not in the image and need no entry here.

Changes under `security/image-scan/` trigger the service pipelines.

## When the scan fails without a finding

Trivy downloads its vulnerability database at the start of the step (the action caches it between runs). If the download fails (registry rate limit or outage), the step fails with a `failed to download vulnerability DB` error and no findings list. That is an infrastructure failure, not a vulnerability: re-run the job. If it persists, the pipeline stays red; do not switch off the scan or set `exit-code: "0"` to get past it. The same happens locally when the registry is unreachable (for example off the corporate network, see CLAUDE.md).

## Configuration

| File | Purpose |
|---|---|
| `.github/workflows/_service.yml` (`Scan image`) | The scan and the gate |
| `security/image-scan/.trivyignore` | Accepted findings with reason and expiry |
| `security/image-scan/README.md` | Folder overview and the local command |
