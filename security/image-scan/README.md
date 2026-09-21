# Image scan (blocking)

The `image` job of every service pipeline (`.github/workflows/_service.yml`) scans the freshly built `<service>:<commit-sha>` image with Trivy before the smoke test and before publish. A fixable HIGH or CRITICAL vulnerability, or a HIGH/CRITICAL secret, fails the pipeline. How it works and what to do when it fails: [docs/security/image-scanning.md](../../docs/security/image-scanning.md).

| File | Purpose |
|---|---|
| `.trivyignore` | Accepted findings, each with a reason line and an `exp:` date of at most 90 days. Empty by default; passed to the scan as `trivyignores` |

Changes under this folder trigger the service pipelines.

```bash
# Same scan as the pipeline, locally (service image built as <service>:local)
docker run --rm -v //var/run/docker.sock:/var/run/docker.sock -v "$PWD/security/image-scan:/ignore:ro" \
  aquasec/trivy image --severity HIGH,CRITICAL --ignore-unfixed --scanners vuln,secret \
  --ignorefile /ignore/.trivyignore user-service:local
```
