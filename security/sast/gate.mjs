// CodeQL quality gate: exits 1 when a SARIF file holds an unsuppressed finding whose rule has a
// security-severity at or above the threshold (7.0 = high and critical, like `npm audit --audit-level=high` and Trivy).
// Usage: node security/sast/gate.mjs <file.sarif>...        (threshold: env CODEQL_FAIL_SEVERITY, default 7.0)
// Fails closed: no SARIF file, or one that cannot be read, is an error, never a pass.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function blockingFindings(sarif, threshold = 7.0) {
  const found = [];
  for (const run of sarif.runs ?? []) {
    const rules = new Map();
    const components = [run.tool?.driver, ...(run.tool?.extensions ?? [])];
    for (const c of components) for (const r of c?.rules ?? []) rules.set(r.id, r);
    for (const res of run.results ?? []) {
      if (res.suppressions?.length) continue;
      const id = res.ruleId ?? res.rule?.id;
      const score = Number(rules.get(id)?.properties?.['security-severity']);
      if (!Number.isFinite(score) || score < threshold) continue;
      const loc = res.locations?.[0]?.physicalLocation;
      found.push({
        rule: id,
        score,
        where: `${loc?.artifactLocation?.uri ?? '?'}:${loc?.region?.startLine ?? '?'}`,
        message: res.message?.text ?? '',
      });
    }
  }
  return found;
}

function main(files) {
  if (files.length === 0) {
    console.error('gate.mjs: no SARIF file given (did the CodeQL analyze step produce output?)');
    return 1;
  }
  const threshold = Number(process.env.CODEQL_FAIL_SEVERITY ?? 7.0);
  let failed = 0;
  for (const file of files) {
    const findings = blockingFindings(JSON.parse(readFileSync(file, 'utf8')), threshold);
    for (const f of findings) console.error(`${f.where}  ${f.rule} (security-severity ${f.score})  ${f.message}`);
    failed += findings.length;
  }
  if (failed > 0) console.error(`CodeQL gate FAILED: ${failed} finding(s) at security-severity >= ${threshold}`);
  else console.log(`CodeQL gate passed: no finding at security-severity >= ${threshold}`);
  return failed > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`gate.mjs: ${err.message}`);
    process.exit(1);
  }
}
