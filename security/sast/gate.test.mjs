// Run: node --test security/sast/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockingFindings } from './gate.mjs';

const rule = (id, score) => ({ id, properties: score === undefined ? {} : { 'security-severity': String(score) } });
const result = (ruleId, extra = {}) => ({
  ruleId,
  message: { text: 'm' },
  locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.ts' }, region: { startLine: 3 } } }],
  ...extra,
});
const sarif = (rules, results, where = 'extensions') => ({
  runs: [{ tool: where === 'driver' ? { driver: { rules } } : { driver: {}, extensions: [{ rules }] }, results }],
});

test('fails on high and critical, ignores medium, low and rules without a security score', () => {
  const s = sarif(
    [rule('js/critical', 9.8), rule('js/high', 7.0), rule('js/medium', 6.9), rule('js/quality')],
    [result('js/critical'), result('js/high'), result('js/medium'), result('js/quality')],
  );
  assert.deepEqual(blockingFindings(s).map((f) => f.rule), ['js/critical', 'js/high']);
});

test('reads rules from the driver as well as from extensions', () => {
  assert.equal(blockingFindings(sarif([rule('js/x', 8)], [result('js/x')], 'driver')).length, 1);
});

test('skips suppressed findings and honors the threshold', () => {
  const s = sarif([rule('js/x', 8)], [result('js/x', { suppressions: [{ kind: 'inSource' }] })]);
  assert.equal(blockingFindings(s).length, 0);
  assert.equal(blockingFindings(sarif([rule('js/x', 5)], [result('js/x')]), 4).length, 1);
});

test('a clean run passes', () => {
  assert.equal(blockingFindings(sarif([rule('js/x', 9)], [])).length, 0);
});

test('cli: exit 1 on a finding, 0 when clean, 1 with no file or an unreadable one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const bad = join(dir, 'bad.sarif');
  const good = join(dir, 'good.sarif');
  writeFileSync(bad, JSON.stringify(sarif([rule('js/x', 9)], [result('js/x')])));
  writeFileSync(good, JSON.stringify(sarif([rule('js/x', 9)], [])));
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./gate.mjs', import.meta.url)), ...args]).status;
  assert.equal(run(bad), 1);
  assert.equal(run(good), 0);
  assert.equal(run(), 1);
  assert.equal(run(join(dir, 'missing.sarif')), 1);
});
