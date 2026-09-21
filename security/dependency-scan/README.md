# Dependency scan (blocking)

The `verify` job of every service pipeline (`.github/workflows/_service.yml`) runs `npm audit --json` and this gate on the service's lockfile. A HIGH or CRITICAL advisory with a fix fails the pipeline unless it has an unexpired, reviewed exception here. How it works and what to do when it fails: [docs/security/dependency-scanning.md](../../docs/security/dependency-scanning.md).

| File | Purpose |
|---|---|
| `gate.mjs` | Reads the `npm audit --json` report, writes the run summary, exits 1 on a blocking advisory or a bad exception (no dependencies, fails closed) |
| `gate.test.mjs` | Test of the gate; the pipeline runs it before the gate |
| `exceptions.json` | Accepted advisories: `id`, `package`, `reason`, `added`, `expires` (at most 90 days) |

```bash
node --test security/dependency-scan/gate.test.mjs
```
