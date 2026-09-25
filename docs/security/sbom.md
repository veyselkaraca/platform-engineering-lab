# SBOM

Requirements: [issue #32](https://github.com/veyselkaraca/platform-engineering-lab/issues/32). Sibling checks: [dependency scanning](dependency-scanning.md), [image scanning](image-scanning.md).

## What runs

The `image` job of `.github/workflows/_service.yml` generates a CycloneDX SBOM for the exact `<service>:<commit-sha>` image that passed the Trivy vuln/secret gate and is about to be smoke-tested and published — never a separately built image:

`... -> Scan image (gate) -> **Generate SBOM** -> Upload SBOM -> smoke test -> publish`

`aquasecurity/trivy-action` runs a second time in `sbom` mode (`format: cyclonedx`, no vulnerability database download) and writes `sbom.cdx.json`, uploaded as a workflow run artifact named `sbom-<service>-<commit-sha>` via `actions/upload-artifact`.

This step is informational, not a gate: it cannot fail the pipeline.

## Retrieving an SBOM for a commit

Workflow run artifacts are listed on the run for that commit (Actions tab, or `gh run list --commit <sha>` / `gh run download`); the artifact name embeds both the service and the SHA, so it does not depend on remembering which run built it.

## Decisions

**Kept as a run artifact, not published to GHCR alongside the image.** Attaching an SBOM to the image in the registry (as an OCI referrer/signature) needs a second tool (`cosign` or `oras`) and its own key/attestation management. The issue's own framing — "no new tool: Trivy is already in the pipeline" — rules that out here. A run artifact named with the commit SHA already satisfies "retrievable for a given commit SHA" without adding one.

**No separate Trivy filesystem/lockfile scan.** `npm audit` (the [dependency-scan gate](dependency-scanning.md), with per-service exceptions) already scans the lockfile that ships in the image, and the Trivy [image scan](image-scanning.md) already re-scans the built `node_modules` plus OS packages. A third scanner over the same lockfile would duplicate both, add CI time, and open a fourth exception surface (alongside `security/dependency-scan/exceptions.json` and `security/image-scan/.trivyignore`) without covering anything the other two miss.

## Configuration

| File | Purpose |
|---|---|
| `.github/workflows/_service.yml` (`Generate SBOM`, `Upload SBOM`) | Produces and stores the SBOM |
