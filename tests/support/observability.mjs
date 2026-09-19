// Helpers for the tests that query the observability backends (Prometheus, Tempo, Loki, Grafana) over their HTTP APIs.
// The stack must be running with the observability profile:
//   docker compose -f infrastructure/docker/docker-compose.yml --profile observability up -d --build --wait
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from './broker.mjs';

export const OBS = {
  prometheus: process.env.PROMETHEUS_URL ?? 'http://localhost:9090',
  tempo: process.env.TEMPO_URL ?? 'http://localhost:3200',
  loki: process.env.LOKI_URL ?? 'http://localhost:3100',
  grafana: process.env.GRAFANA_URL ?? 'http://localhost:3000',
};

function envValue(key) {
  if (process.env[key]) return process.env[key];
  const env = readFileSync(resolve(repoRoot, 'infrastructure/docker/.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [k, ...rest] = line.split('=');
    if (k === key) return rest.join('=');
  }
  throw new Error(`${key} is not set (run scripts/bootstrap.sh)`);
}

const grafanaAuth = () => `Basic ${Buffer.from(`${envValue('GRAFANA_ADMIN_USER')}:${envValue('GRAFANA_ADMIN_PASSWORD')}`).toString('base64')}`;

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { connection: 'close', ...headers }, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

export const grafana = (path) => getJson(`${OBS.grafana}${path}`, { authorization: grafanaAuth() });

// Instant query. Returns the result vector: [{ metric, value: [ts, "n"] }].
export async function promQuery(expr) {
  const res = await getJson(`${OBS.prometheus}/api/v1/query?query=${encodeURIComponent(expr)}`);
  if (res.status !== 200 || res.body.status !== 'success') throw new Error(`Prometheus rejected ${expr}: ${JSON.stringify(res.body)}`);
  return res.body.data.result;
}
export const promScalar = async (expr) => {
  const [first] = await promQuery(expr);
  return first ? Number(first.value[1]) : 0;
};
export const promAlerts = async () => (await getJson(`${OBS.prometheus}/api/v1/alerts`)).body.data.alerts;

// A trace as Tempo returns it, flattened: [{ service, name, kind, attributes }]. null until Tempo has it.
export async function tempoSpans(traceId) {
  const res = await getJson(`${OBS.tempo}/api/traces/${traceId}`);
  if (res.status !== 200) return null;
  const spans = [];
  for (const batch of res.body.batches ?? []) {
    const service = batch.resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue;
    for (const scope of batch.scopeSpans ?? []) {
      for (const span of scope.spans) {
        spans.push({ service, name: span.name, kind: span.kind, attributes: Object.fromEntries((span.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]])), raw: span });
      }
    }
  }
  return spans;
}

// Log lines of a LogQL query in the last `minutes`: [{ service, line, labels }].
export async function lokiLines(query, minutes = 15) {
  const start = (Date.now() - minutes * 60_000) * 1e6;
  const res = await getJson(`${OBS.loki}/loki/api/v1/query_range?limit=1000&start=${start}&query=${encodeURIComponent(query)}`);
  if (res.status !== 200) throw new Error(`Loki ${res.status} for ${query}`);
  return res.body.data.result.flatMap((s) => s.values.map(([, line]) => ({ service: s.stream.service_name, line, labels: s.stream })));
}

// A random W3C trace id plus the traceparent header that makes the gateway continue it.
export function newTrace() {
  const traceId = randomBytes(16).toString('hex');
  return { traceId, traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01` };
}
