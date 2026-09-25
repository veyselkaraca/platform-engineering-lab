// Run: node --test security/dependency-scan/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advisories, evaluate, summary } from './gate.mjs';

const NOW = new Date('2026-09-21T12:00:00Z');
const adv = (id, severity) => ({ source: 1, name: 'x', title: `t ${id}`, url: `https://github.com/advisories/${id}`, severity });
// Shape of `npm audit --json` (auditReportVersion 2): one entry per package, advisories in `via`.
const audit = (vulnerabilities) => ({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { total: 1 } } });
const pkg = (via, fixAvailable = true) => ({ via, fixAvailable });
const exception = (over = {}) => ({ id: 'GHSA-aaaa', package: 'lodash', reason: 'not reachable', added: '2026-09-01', expires: '2026-10-01', ...over });
const statuses = (a, exceptions = [], service) => evaluate(a, exceptions, service, NOW).rows.map((r) => `${r.id}:${r.status}`);

test('a fixable high or critical advisory blocks', () => {
  const a = audit({ lodash: pkg([adv('GHSA-aaaa', 'high')]), minimist: pkg([adv('GHSA-bbbb', 'critical')]) });
  const r = evaluate(a, [], undefined, NOW);
  assert.equal(r.ok, false);
  assert.deepEqual(statuses(a), ['GHSA-aaaa:blocking', 'GHSA-bbbb:blocking']);
});

test('an advisory with no fix is listed but does not block', () => {
  const a = audit({ lodash: pkg([adv('GHSA-aaaa', 'critical')], false) });
  assert.deepEqual(statuses(a), ['GHSA-aaaa:no fix']);
  assert.equal(evaluate(a, [], undefined, NOW).ok, true);
});

test('moderate and low advisories pass and are not listed, even next to a high one in the same package', () => {
  const a = audit({ lodash: pkg([adv('GHSA-aaaa', 'moderate'), adv('GHSA-bbbb', 'low'), adv('GHSA-cccc', 'high')]) });
  assert.deepEqual(statuses(a), ['GHSA-cccc:blocking']);
  assert.equal(evaluate(audit({ lodash: pkg([adv('GHSA-aaaa', 'moderate')]) }), [], undefined, NOW).ok, true);
});

test('a transitive package is read from the package that owns the advisory, once', () => {
  const a = audit({ lodash: pkg([adv('GHSA-aaaa', 'high')]), app: pkg(['lodash']), root: pkg(['app']) });
  assert.deepEqual(statuses(a), ['GHSA-aaaa:blocking']);
  assert.equal(advisories(a).length, 1);
});

test('a valid exception passes and is reported as excepted', () => {
  const a = audit({ lodash: pkg([adv('GHSA-aaaa', 'high')]) });
  const r = evaluate(a, [exception()], undefined, NOW);
  assert.deepEqual(statuses(a, [exception()]), ['GHSA-aaaa:excepted']);
  assert.equal(r.ok, true);
  assert.match(r.rows[0].note, /2026-10-01.*not reachable/);
});

test('an exception for another advisory or package does not apply', () => {
  const a = audit({ lodash: pkg([adv('GHSA-aaaa', 'high')]) });
  assert.deepEqual(statuses(a, [exception({ id: 'GHSA-zzzz' })]), ['GHSA-aaaa:blocking']);
  assert.deepEqual(statuses(a, [exception({ package: 'other' })]), ['GHSA-aaaa:blocking']);
});

test('an exception without services applies to every service', () => {
  const a = audit({ lodash: pkg([adv('GHSA-aaaa', 'high')]) });
  assert.deepEqual(statuses(a, [exception()], 'user-service'), ['GHSA-aaaa:excepted']);
  assert.deepEqual(statuses(a, [exception()], 'order-service'), ['GHSA-aaaa:excepted']);
  assert.deepEqual(statuses(a, [exception()], undefined), ['GHSA-aaaa:excepted']);
});

test('an exception scoped to services only applies to a matching service', () => {
  const a = audit({ lodash: pkg([adv('GHSA-aaaa', 'high')]) });
  const scoped = [exception({ services: ['user-service', 'order-service'] })];
  assert.deepEqual(statuses(a, scoped, 'user-service'), ['GHSA-aaaa:excepted']);
  assert.deepEqual(statuses(a, scoped, 'notification-worker'), ['GHSA-aaaa:blocking']);
  assert.deepEqual(statuses(a, scoped, undefined), ['GHSA-aaaa:blocking']);
});

test('a services field that is not a non-empty array of strings fails the gate', () => {
  const clean = audit({});
  for (const services of ['user-service', [], [1], [''], ['user-service', 2]]) {
    const r = evaluate(clean, [exception({ services })], undefined, NOW);
    assert.equal(r.ok, false, JSON.stringify(services));
    assert.match(r.problems[0], /services must be a non-empty array of service names/);
  }
});

test('an exception is valid through its expiry day and fails the gate after it', () => {
  const a = audit({ lodash: pkg([adv('GHSA-aaaa', 'high')]) });
  assert.equal(evaluate(a, [exception({ expires: '2026-09-21' })], undefined, NOW).ok, true);
  const r = evaluate(a, [exception({ expires: '2026-09-20' })], undefined, NOW);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /expired on 2026-09-20/);
});

test('an exception with no reason, bad dates or more than 90 days fails, even with nothing to except', () => {
  const clean = audit({});
  for (const bad of [{ reason: ' ' }, { expires: 'soon' }, { added: undefined }, { expires: '2026-12-15' }, { id: undefined }]) {
    assert.equal(evaluate(clean, [exception(bad)], undefined, NOW).ok, false, JSON.stringify(bad));
  }
  assert.equal(evaluate(clean, [exception({ expires: '2026-11-30' })], undefined, NOW).ok, true); // 90 days from 2026-09-01
  assert.equal(evaluate(clean, {}, undefined, NOW).ok, false);
});

test('an npm audit error or something that is not a report is an error, never a pass', () => {
  assert.throws(() => evaluate({ message: 'request failed', error: { summary: '', detail: '' } }, [], undefined, NOW), /npm audit failed: request failed/);
  assert.throws(() => evaluate({}, [], undefined, NOW), /not an npm audit report/);
  assert.throws(() => evaluate(null, [], undefined, NOW), /not an npm audit report/);
});

test('summary reports the status of every high/critical advisory', () => {
  const a = audit({ lodash: pkg([adv('GHSA-aaaa', 'high')]), minimist: pkg([adv('GHSA-bbbb', 'critical')], false) });
  const md = summary(evaluate(a, [exception()], undefined, NOW), 'user-service', 2);
  assert.match(md, /### Dependency scan: user-service/);
  assert.match(md, /Passed\. 2 advisories in total, 2 high\/critical/);
  assert.match(md, /\| lodash \| GHSA-aaaa \| high \| excepted \|/);
  assert.match(md, /\| minimist \| GHSA-bbbb \| critical \| no fix \|/);
  const failed = summary(evaluate(a, [], undefined, NOW), '', 2);
  assert.match(failed, /FAILED/);
  assert.match(failed, /\| lodash \| GHSA-aaaa \| high \| blocking \|/);
});

test('cli: exit codes, exceptions file and the step summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'depgate-'));
  const file = (name, content) => {
    const p = join(dir, name);
    writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
    return p;
  };
  const bad = file('bad.json', audit({ lodash: pkg([adv('GHSA-aaaa', 'high')]) }));
  const clean = file('clean.json', audit({}));
  const none = file('none.json', []);
  const excepted = file('exc.json', [exception({ added: '2099-01-01', expires: '2099-02-01' })]);
  const stepSummary = join(dir, 'summary.md');
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [fileURLToPath(new URL('./gate.mjs', import.meta.url)), ...args], {
      env: { ...process.env, DEP_EXCEPTIONS: none, GITHUB_STEP_SUMMARY: stepSummary, ...env },
    }).status;

  assert.equal(run([bad]), 1);
  assert.match(readFileSync(stepSummary, 'utf8'), /FAILED/);
  assert.equal(run([clean]), 0);
  assert.equal(run([bad], { DEP_EXCEPTIONS: excepted }), 0);
  assert.equal(run([file('err.json', { error: { summary: 'offline' } })]), 1);
  assert.equal(run([file('junk.json', 'not json')]), 1);
  assert.equal(run([]), 1);
  assert.equal(run([join(dir, 'missing.json')]), 1);
  assert.equal(run([clean], { DEP_EXCEPTIONS: join(dir, 'missing.json') }), 1);
});
