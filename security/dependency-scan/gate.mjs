// Dependency advisory gate: reads `npm audit --json` output and exits 1 on a HIGH/CRITICAL advisory that has a fix
// and no valid exception. Same bar as CodeQL (security-severity >= 7.0) and Trivy `HIGH,CRITICAL --ignore-unfixed`.
// Usage: node security/dependency-scan/gate.mjs <audit.json>
//   SERVICE          service name: shown in the summary and matched against exceptions' `services` (optional)
//   DEP_EXCEPTIONS   exceptions file (default: exceptions.json next to this script)
// Fails closed: an npm audit error, unreadable output or a malformed exception is an error, never a pass.
// The Markdown report goes to $GITHUB_STEP_SUMMARY when set, otherwise it is not written.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BLOCKING = new Set(['high', 'critical']);
const MAX_EXCEPTION_DAYS = 90;
const DAY = 86_400_000;

// One entry per (advisory, package); transitive entries only point at the package that owns the advisory.
export function advisories(audit) {
  if (audit?.error) throw new Error(`npm audit failed: ${audit.message || audit.error.summary || audit.error.code || 'unknown error'}`);
  if (!audit?.vulnerabilities || !audit?.metadata) throw new Error('not an npm audit report (no vulnerabilities/metadata)');
  const found = new Map();
  for (const [pkg, v] of Object.entries(audit.vulnerabilities)) {
    for (const via of v.via ?? []) {
      if (typeof via === 'string') continue;
      const id = via.url?.split('/').pop() ?? String(via.source);
      found.set(`${id} ${pkg}`, {
        id,
        pkg,
        severity: via.severity,
        title: via.title ?? '',
        fixable: v.fixAvailable !== false,
      });
    }
  }
  return [...found.values()];
}

// Returns the exceptions that are in force and the problems with the rest.
export function checkExceptions(list, now = new Date()) {
  const valid = [];
  const problems = [];
  if (!Array.isArray(list)) return { valid, problems: ['exceptions file must hold a JSON array'] };
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const e of list) {
    const name = `exception ${e?.id ?? '?'} (${e?.package ?? '?'})`;
    const added = Date.parse(e?.added);
    const expires = Date.parse(e?.expires);
    const badServices = e?.services !== undefined && (!Array.isArray(e.services) || !e.services.length || !e.services.every((s) => typeof s === 'string' && s));
    if (!e?.id || !e?.package || !e?.reason?.trim()) problems.push(`${name}: id, package and reason are required`);
    else if (!Number.isFinite(added) || !Number.isFinite(expires)) problems.push(`${name}: added and expires must be dates (YYYY-MM-DD)`);
    else if (expires - added > MAX_EXCEPTION_DAYS * DAY) problems.push(`${name}: lasts more than ${MAX_EXCEPTION_DAYS} days`);
    else if (expires < today) problems.push(`${name}: expired on ${e.expires}, fix the dependency or renew it with a new reason`);
    else if (badServices) problems.push(`${name}: services must be a non-empty array of service names`);
    else valid.push(e);
  }
  return { valid, problems };
}

export function evaluate(audit, exceptions, service, now = new Date()) {
  const { valid, problems } = checkExceptions(exceptions, now);
  const rows = advisories(audit)
    .filter((a) => BLOCKING.has(a.severity))
    .map((a) => {
      const exc = valid.find((e) => e.id === a.id && e.package === a.pkg && (!e.services || e.services.includes(service)));
      const status = exc ? 'excepted' : a.fixable ? 'blocking' : 'no fix';
      return { ...a, status, note: exc ? `until ${exc.expires}: ${exc.reason}` : '' };
    });
  const blocking = rows.filter((r) => r.status === 'blocking');
  return { rows, blocking, problems, ok: blocking.length === 0 && problems.length === 0 };
}

export function summary(result, service, total) {
  const head = `### Dependency scan${service ? `: ${service}` : ''}\n\n`;
  const state = result.ok ? 'Passed' : 'FAILED';
  const lines = [`${head}${state}. ${total} advisories in total, ${result.rows.length} high/critical.\n`];
  for (const p of result.problems) lines.push(`- ${p}`);
  if (result.rows.length) {
    lines.push('', '| Package | Advisory | Severity | Status | Note |', '|---|---|---|---|---|');
    for (const r of result.rows) lines.push(`| ${r.pkg} | ${r.id} | ${r.severity} | ${r.status} | ${r.note} |`);
  }
  return lines.join('\n') + '\n';
}

function main(files) {
  if (files.length !== 1) {
    console.error('gate.mjs: usage: gate.mjs <audit.json> (did `npm audit --json` write its output?)');
    return 1;
  }
  const excFile = process.env.DEP_EXCEPTIONS ?? join(dirname(fileURLToPath(import.meta.url)), 'exceptions.json');
  const audit = JSON.parse(readFileSync(files[0], 'utf8'));
  const result = evaluate(audit, JSON.parse(readFileSync(excFile, 'utf8')), process.env.SERVICE);
  const report = summary(result, process.env.SERVICE, audit.metadata?.vulnerabilities?.total ?? 0);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  for (const p of result.problems) console.error(p);
  for (const r of result.rows) console.error(`${r.pkg}  ${r.id} (${r.severity})  ${r.status}  ${r.title}`);
  if (result.ok) console.log('Dependency gate passed: no fixable high/critical advisory without a valid exception');
  else console.error(`Dependency gate FAILED: ${result.blocking.length} blocking advisory(ies), ${result.problems.length} exception problem(s)`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`gate.mjs: ${err.message}`);
    process.exit(1);
  }
}
