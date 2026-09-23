# Runbook: cutting and fixing a release

Applies to the `release` GitHub Actions workflow (`.github/workflows/release.yml`), driven by release-please from Conventional Commits on `main`. See `ci/github-actions/README.md` for the pipeline overview and `docs/architecture/engineering-standards.md` for immutable artifacts.

## Symptom

- A release-please pull request is open against `main` (title `chore(main): release X.Y.Z`), or is expected but missing.
- Or: the `release` workflow's `retag` job failed after a release PR was merged.

## 1. Cut a release

Review the open release PR: the version bump in `.release-please-manifest.json` / the four `services/*/package.json`, and the `CHANGELOG.md` entry it proposes. Merging it is the deliberate step (nothing before this is automatic):

```bash
gh pr list --search "chore(main): release" --state open
gh pr merge <pr-number> --squash
```

Merging triggers, in parallel on the same push: the four service pipelines (build, scan, publish `<service>:<commit-sha>`) and the `release` workflow. `release-please` creates the `vX.Y.Z` tag and the GitHub Release immediately (it does not wait on the four pipelines); `retag` then waits for each `<service>:<commit-sha>` image and adds `<service>:vX.Y.Z` on the same digest. A tag/Release existing before every image is confirmed is a known gap (see §3) — a failed `retag` run is the visible signal, not a hidden release.

## 2. Correct a release before it is tagged

The version or changelog text in the open PR is wrong, and no tag exists yet — `main` history is not rewritten by release-please, so fix the PR instead of anything already merged:

- Edit the changelog wording directly in the PR's diff (release-please keeps the PR up to date with new commits, but a manual edit to prose is preserved until the next commit changes that section).
- Force a specific version: push a commit with a `Release-As: X.Y.Z` footer; release-please recomputes the PR on the next push.

## 3. Fix a failed or stuck retag

The `retag` job is idempotent and safe to re-run (`docker buildx imagetools create` is a registry-only operation, no pull, no rebuild):

```bash
gh run list --workflow release.yml --branch main
gh run rerun <run-id> --failed
```

- **A service's wait step failed fast** (before the 30-minute timeout): its pipeline (`gh run list --workflow <service>.yml --branch main`) already concluded `failure`, `cancelled` or `timed_out` for this commit — the retag step checks this on every poll and exits immediately rather than waiting out the image that will never appear. Fix the pipeline, push a follow-up commit if needed, then re-run the retag job once `<service>:<commit-sha>` exists.
- **Timed out after 30 minutes**: the pipeline is still running (queued behind other jobs, or just slow) rather than failed. Check `gh run list --workflow <service>.yml --branch main` for that commit and either wait for it or re-run the retag job once it finishes.
- **`docker buildx imagetools create` failed**: check the job log for the registry error; re-running is always safe once the underlying cause (auth, a transient GHCR error) is gone.
- A `gh run rerun` reruns the workflow file as it existed at that commit, so it cannot pick up a fix made after the fact — a bug in `release.yml` itself needs a fresh commit/push (a new release cycle) to take effect, not a rerun of an old run.

## 4. Verify

```bash
docker buildx imagetools inspect ghcr.io/<owner>/<repo>/<service>:vX.Y.Z --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/<owner>/<repo>/<service>:<commit-sha> --format '{{.Manifest.Digest}}'
```

Both digests match for all four services. The GitHub Release exists and the `CHANGELOG.md` entry is on `main`.

## After the tag exists

Tags are immutable (REL-3): never move or delete `vX.Y.Z`. A wrong release found after merge is corrected by shipping a normal patch commit and letting the next release PR cut `vX.Y.Z+1`, not by editing the tag. Rolling the *runtime* back to a previous version is a deploy-time concern (rollback runbook, once #15 lands) — the version tag just resolves to a digest, it does not deploy anything by itself.

## Related

- Workflow: `.github/workflows/release.yml`; config: `release-please-config.json`, `.release-please-manifest.json`.
- Commit message convention is enforced before release-please ever sees a commit: `.github/workflows/commit-lint.yml`, `security/commit-lint/gate.mjs`.
- Registry and tagging conventions: `ci/github-actions/README.md`.
- Immutable artifacts / rollback principles: `docs/architecture/engineering-standards.md`.
