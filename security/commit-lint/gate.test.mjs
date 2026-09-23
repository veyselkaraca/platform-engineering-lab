// Run: node --test security/commit-lint/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { invalidSubjects } from './gate.mjs';

test('accepts conventional subjects, with and without a scope, and breaking-change !', () => {
  assert.deepEqual(
    invalidSubjects([
      'feat(order-service): publish order.created to RabbitMQ',
      'fix: escape the dot in the log pattern (#30)',
      'ci: run the pipelines on every branch (#30)',
      'feat!: drop the legacy /v0 routes',
    ]),
    [],
  );
});

test('accepts a git revert commit and a merge commit', () => {
  assert.deepEqual(
    invalidSubjects([
      'Revert "ci: gate the service pipelines on a SonarQube quality gate (#2)"',
      'Merge pull request #12 from user/branch',
      'Merge branch \'main\' into feature',
    ]),
    [],
  );
});

test('rejects an unknown type, a missing subject and free text', () => {
  const invalid = invalidSubjects(['update stuff', 'unknown: add a thing', 'fix: ', 'fix:no space']);
  assert.equal(invalid.length, 4);
  assert.equal(invalid[0].subject, 'update stuff');
});

test('ignores blank lines', () => {
  assert.deepEqual(invalidSubjects(['', '  ', 'fix: ok (#1)', '']), []);
});

test('cli: exit 1 on a bad subject, 0 when all subjects conform or stdin is empty', () => {
  const run = (input) =>
    spawnSync(process.execPath, [fileURLToPath(new URL('./gate.mjs', import.meta.url))], { input }).status;
  assert.equal(run('update stuff\n'), 1);
  assert.equal(run('fix: ok (#1)\nfeat(x): ok\n'), 0);
  assert.equal(run(''), 0);
});
