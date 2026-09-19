// Helpers for the disruptive tests (tests/chaos/*.chaos.mjs) that stop and start services of the compose stack.
import { execFileSync } from 'node:child_process';
import { repoRoot } from './broker.mjs';
import { eventually } from './stack.mjs';

export const COMPOSE = ['compose', '-f', 'infrastructure/docker/docker-compose.yml'];
export const docker = (...args) => execFileSync('docker', [...COMPOSE, ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const status = (url) => fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => r.status, () => 0);

// Runs a query in one of the service databases; the credentials stay inside the container. `db` is a constant in tests.
export const psql = (db, query) =>
  docker('exec', '-T', 'postgres', 'sh', '-c', `psql -U "$POSTGRES_USER" -d ${db} -tA -c "$1"`, '_', query).trim();

export const logsSince = (service, since) => docker('logs', '--no-log-prefix', '--since', since, service);
export const countMatches = (text, pattern) => (text.match(new RegExp(pattern, 'g')) ?? []).length;

export const waitReady = (baseUrl, timeoutMs = 90_000) =>
  eventually(async () => (await status(`${baseUrl}/health/ready`)) === 200, { timeoutMs, intervalMs: 1000 });
