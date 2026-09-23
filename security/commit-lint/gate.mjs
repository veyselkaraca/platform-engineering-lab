// Conventional Commits gate: exits 1 when a pushed commit's subject doesn't follow
// `type(scope)?!: subject` (feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert).
// A `git revert` commit (`Revert "..."`) and a merge commit are exempt, matching commitlint's defaults.
// Usage: printf '%s\n' <subject>... | node security/commit-lint/gate.mjs   (one subject per stdin line)
// No commits on stdin is not a failure: nothing to check.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];
const CONVENTIONAL = new RegExp(`^(${TYPES.join('|')})(\\([\\w./-]+\\))?!?: \\S.*$`);
const EXEMPT = /^(Revert ".+"|Merge (pull request|branch) )/;

export function invalidSubjects(subjects) {
  return subjects
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !EXEMPT.test(s) && !CONVENTIONAL.test(s))
    .map((subject) => ({
      subject,
      reason: `must match "type(scope)?: subject" with type one of ${TYPES.join(', ')}`,
    }));
}

function main(stdin) {
  const subjects = stdin.split('\n');
  const invalid = invalidSubjects(subjects);
  for (const f of invalid) console.error(`"${f.subject}"  ${f.reason}`);
  if (invalid.length > 0) console.error(`Commit message gate FAILED: ${invalid.length} non-conforming subject(s)`);
  else console.log('Commit message gate passed');
  return invalid.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(readFileSync(0, 'utf8')));
  } catch (err) {
    console.error(`gate.mjs: ${err.message}`);
    process.exit(1);
  }
}
