// Image-scan exception gate: enforces that every entry in security/image-scan/.trivyignore has a reason
// comment on the line directly above it and an `exp:` date at most 90 days out. Trivy enforces the expiry
// itself (stops ignoring the id after that date) but not the upper bound, and accepts a bare id with no
// reason at all — this gate closes both gaps. Same bar as security/dependency-scan/gate.mjs.
// Usage: node security/image-scan/gate.mjs [.trivyignore]
//   TRIVYIGNORE   ignore file (default: .trivyignore next to this script)
// Fails closed: an unreadable file is an error, never a pass.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_EXCEPTION_DAYS = 90;
const DAY = 86_400_000;
const EXP = /\bexp:(\d{4}-\d{2}-\d{2})\b/;

// One entry per non-comment, non-blank line. The reason is the comment immediately above it (a blank line
// breaks the association, same as the one-comment-one-id pairing documented in the file's own header).
export function parse(text) {
  const entries = [];
  let reason = null;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '') { reason = null; return; }
    if (line.startsWith('#')) { reason = line.slice(1).trim(); return; }
    entries.push({ id: line.split(/\s+/)[0], reason, expMatch: line.match(EXP), lineNo: i + 1 });
    reason = null;
  });
  return entries;
}

export function checkEntries(entries, now = new Date()) {
  const problems = [];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const e of entries) {
    const name = `${e.id} (line ${e.lineNo})`;
    if (!e.reason) problems.push(`${name}: needs a reason comment on the line above`);
    else if (!e.expMatch) problems.push(`${name}: needs an exp:YYYY-MM-DD date`);
    else if (Date.parse(e.expMatch[1]) - today > MAX_EXCEPTION_DAYS * DAY)
      problems.push(`${name}: exp is more than ${MAX_EXCEPTION_DAYS} days out (${e.expMatch[1]})`);
  }
  return problems;
}

export function evaluate(text, now = new Date()) {
  const entries = parse(text);
  const problems = checkEntries(entries, now);
  return { entries, problems, ok: problems.length === 0 };
}

function main(args) {
  const file = args[0] ?? process.env.TRIVYIGNORE ?? join(dirname(fileURLToPath(import.meta.url)), '.trivyignore');
  const result = evaluate(readFileSync(file, 'utf8'));
  for (const p of result.problems) console.error(p);
  if (result.ok) console.log(`Image-scan exception gate passed: ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'} checked`);
  else console.error(`Image-scan exception gate FAILED: ${result.problems.length} problem(s)`);
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
