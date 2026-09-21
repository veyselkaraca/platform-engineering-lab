# Dependency scanning

Requirements, design and test plan: [issue #3](https://github.com/veyselkaraca/platform-engineering-lab/issues/3). Follow-ups: [#31](https://github.com/veyselkaraca/platform-engineering-lab/issues/31) (Dependabot), [#32](https://github.com/veyselkaraca/platform-engineering-lab/issues/32) (SBOM, Trivy filesystem scan), [#33](https://github.com/veyselkaraca/platform-engineering-lab/issues/33) (per-service exceptions).

## What runs

The `verify` job of `.github/workflows/_service.yml` scans the `package-lock.json` of the service under test, after lint, test and build and before the image build (`image` needs `verify`):

1. `node --test security/dependency-scan/gate.test.mjs` tests the gate.
2. `npm audit --json` writes the advisory report. Its exit code is ignored on purpose: the gate decides.
3. `node security/dependency-scan/gate.mjs` reads the report and exits 1 on a blocking advisory.

The three scanners in the pipeline fail at the same level (see [static-analysis.md](static-analysis.md)).

## The gate

| Advisory | Result | Summary status |
|---|---|---|
| HIGH or CRITICAL, fix available | fails the job | `blocking` |
| HIGH or CRITICAL, no fix available (`fixAvailable: false`) | passes, like Trivy `--ignore-unfixed` | `no fix` |
| HIGH or CRITICAL with a valid exception | passes | `excepted` |
| MODERATE or LOW | passes, not listed | - |

- It fails closed: an `npm audit` error (registry unreachable), output that is not an audit report, unreadable JSON or a missing argument exits 1.
- Advisories are read from the `via` objects of the report, so a transitive dependency is reported once, on the package that owns the advisory.
- The report is appended to the run summary (`$GITHUB_STEP_SUMMARY`), one row per high/critical advisory with package, advisory, severity, status and the exception's reason and expiry. The failing step prints the same as `package advisory (severity) status title`.

## Exceptions

`security/dependency-scan/exceptions.json` is a JSON array, empty by default. One entry per advisory and package, for all services:

```json
{
  "id": "GHSA-xxxx-xxxx-xxxx",
  "package": "example-package",
  "reason": "Vulnerable function is not called; upgrade blocked by <reason>",
  "added": "2026-09-21",
  "expires": "2026-10-21"
}
```

The gate fails when an entry has no `id`, `package` or `reason`, has dates that are not `YYYY-MM-DD`, lasts more than 90 days (`expires` minus `added`) or is past its `expires` date (valid through that day). It checks every entry, also one that matches nothing, so a stale exception cannot sit in the file unnoticed. Changes under `security/dependency-scan/` trigger the service pipelines.

An exception covers this gate only. The Trivy image scan (`image` job) is separate: a production dependency that is excepted here is still reported there when it is fixable and HIGH/CRITICAL, and fails the job. For a production dependency, add an entry for the same advisory with the same expiry (Trivy's `exp:` syntax) to `security/image-scan/.trivyignore` in the same change (format: [image-scanning.md](image-scanning.md#exceptions)), and remove both together. Dev-only dependencies are not in the image and need no second entry. (Seen in the throwaway run of #3: the dependency gate passed with the exception, `image` failed in Trivy on the same package.)

## When the gate fails

1. Read the `Fail on fixable high/critical advisories` step and the run summary: they name the package and the GHSA id.
2. Update the dependency (`npm audit fix`, or a manual bump; NestJS stays on 11 and `jose` on ^5, see CLAUDE.md). Do it in every service that has the advisory.
3. If it cannot be updated, add an exception with a real reason and an expiry of at most 90 days, in a reviewed change. Do not lower the severity, skip the step or ignore a package anywhere else.
4. An expired exception fails with its id: fix the dependency and remove the entry, or renew it with a new reason and dates.
5. `npm audit failed: ...` means the advisory database could not be reached (it uses the registry like `npm ci`); re-run the job. The gate never passes on an audit error.

## Run it locally

```bash
node --test security/dependency-scan/gate.test.mjs
cd services/user-service && npm audit --json > /tmp/audit.json; node ../../security/dependency-scan/gate.mjs /tmp/audit.json
```

`SERVICE` (name in the summary) and `DEP_EXCEPTIONS` (exceptions file) are optional environment variables.

## What this does not cover

- Advisories that are not yet in the npm advisory database, and packages that are not in the lockfile: image contents are scanned by Trivy in the `image` job, an SBOM and a filesystem scan are [#32](https://github.com/veyselkaraca/platform-engineering-lab/issues/32).
- Updating dependencies: [#31](https://github.com/veyselkaraca/platform-engineering-lab/issues/31).
- License checks, and medium/low advisories as blocking.
