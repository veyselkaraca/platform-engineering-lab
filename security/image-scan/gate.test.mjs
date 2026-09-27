// Run: node --test security/image-scan/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, evaluate } from './gate.mjs';

const NOW = new Date('2026-09-21T12:00:00Z');
const entry = (reason = 'not reachable, reviewed by dev on 2026-09-01', exp = '2026-11-30', id = 'CVE-2026-12345') =>
  `# ${reason}\n${id} exp:${exp}\n`;

test('a well-formed entry passes', () => {
  const r = evaluate(entry());
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 1);
});

test('an entry with no reason comment above it fails', () => {
  const r = evaluate('CVE-2026-12345 exp:2026-11-30\n', NOW);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /needs a reason comment/);
});

test('a blank line between the comment and the id breaks the pairing', () => {
  const r = evaluate('# reviewed by dev on 2026-09-01\n\nCVE-2026-12345 exp:2026-11-30\n', NOW);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /needs a reason comment/);
});

test('an entry with no exp: date fails', () => {
  const r = evaluate('# reviewed by dev on 2026-09-01\nCVE-2026-12345\n', NOW);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /needs an exp:YYYY-MM-DD date/);
});

test('exp is valid through exactly 90 days out and fails past it', () => {
  assert.equal(evaluate(entry(undefined, '2026-12-20'), NOW).ok, true); // 90 days from 2026-09-21
  const r = evaluate(entry(undefined, '2026-12-21'), NOW);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /more than 90 days out/);
});

test('an empty or comment-only file (the shipped default) passes with nothing to check', () => {
  assert.deepEqual(parse(''), []);
  const r = evaluate('# Accepted image findings, see security/image-scan/README.md.\n# Empty on purpose.\n', NOW);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 0);
});

test('each entry needs its own comment: one reason does not cover two ids', () => {
  const r = evaluate('# reviewed by dev on 2026-09-01\nCVE-2026-12345 exp:2026-11-30\nCVE-2026-67890 exp:2026-11-30\n', NOW);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /CVE-2026-67890.*needs a reason comment/);
});

test('one bad entry among good ones is reported without failing the good one', () => {
  const text = entry(undefined, '2026-11-30', 'CVE-2026-11111') + '\n' + 'CVE-2026-22222 exp:2026-11-30\n';
  const r = evaluate(text, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /CVE-2026-22222/);
});

test('cli: exit codes and fail-closed on a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imggate-'));
  const file = (name, content) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };
  // The CLI has no `now` override (unlike the unit tests above), so this exp date is relative to the real clock.
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const good = file('good.trivyignore', entry(undefined, soon));
  const bad = file('bad.trivyignore', `CVE-2026-12345 exp:${soon}\n`);
  const run = (args) => spawnSync(process.execPath, [fileURLToPath(new URL('./gate.mjs', import.meta.url)), ...args]).status;

  assert.equal(run([good]), 0);
  assert.equal(run([bad]), 1);
  assert.equal(run([join(dir, 'missing.trivyignore')]), 1);
});

test('the shipped .trivyignore (comments only) passes as-is', () => {
  const real = readFileSync(new URL('./.trivyignore', import.meta.url), 'utf8');
  assert.equal(evaluate(real).ok, true);
});
