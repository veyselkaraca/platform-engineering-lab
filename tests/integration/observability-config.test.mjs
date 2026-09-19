// Static checks on the observability configuration: no stack needed (OBN-4, OBN-5, OB-8, OB-9, OB-11).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

describe('dashboards as code', () => {
  const dir = resolve(root, 'observability/grafana/dashboards');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  it('include platform health and application health', () => {
    assert.deepEqual(files.sort(), ['application-health.json', 'platform-health.json']);
  });

  for (const file of files) {
    describe(file, () => {
      const dashboard = JSON.parse(readFileSync(resolve(dir, file), 'utf8'));

      it('has a stable uid, is not editable in place and refreshes on its own', () => {
        assert.equal(`${dashboard.uid}.json`, file);
        assert.equal(dashboard.editable, false);
        assert.ok(dashboard.refresh);
      });

      it('has unique panel ids and only references the provisioned datasources', () => {
        const ids = dashboard.panels.map((p) => p.id);
        assert.equal(new Set(ids).size, ids.length);
        for (const panel of dashboard.panels.filter((p) => p.type !== 'row')) {
          assert.ok(['prometheus', 'loki', 'tempo'].includes(panel.datasource?.uid), `${panel.title}: datasource`);
          assert.ok(panel.targets.length > 0, `${panel.title}: no queries`);
          assert.ok(panel.title, 'panel without a title');
        }
      });

      it('explains what it shows and stays readable (no panel without a row above it)', () => {
        assert.ok(dashboard.description.length > 20);
        assert.equal(dashboard.panels[0].type, 'row');
      });
    });
  }

  it('the application dashboard can be filtered by service', () => {
    const dashboard = JSON.parse(readFileSync(resolve(dir, 'application-health.json'), 'utf8'));
    assert.ok(dashboard.templating.list.some((v) => v.name === 'service'));
  });
});

describe('alert rules as code', () => {
  const rules = read('observability/prometheus/rules/platform.yml');
  const alerts = [...rules.matchAll(/- alert: (\w+)\n([\s\S]*?)(?=\n {6}- (?:alert|record)|\n {2}- name|$)/g)];

  it('has alerts', () => assert.ok(alerts.length >= 13, `${alerts.length} alerts`));

  it('every alert has a severity, a summary and a runbook that exists, section included', () => {
    for (const [, name, body] of alerts) {
      assert.match(body, /severity: (critical|warning)/, `${name}: severity`);
      assert.match(body, /summary:/, `${name}: summary`);
      const runbook = /runbook: (\S+?)(?:#(\S+))?\n/.exec(body);
      assert.ok(runbook, `${name}: runbook`);
      const [, path, anchor] = runbook;
      assert.ok(existsSync(resolve(root, path)), `${name}: ${path} does not exist`);
      if (anchor) {
        const slugs = [...read(path).matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'));
        assert.ok(slugs.includes(anchor), `${name}: no section "${anchor}" in ${path}`);
      }
    }
  });

  it('has unit tests next to it', () => assert.ok(existsSync(resolve(root, 'observability/prometheus/tests/platform.test.yml'))));
});

describe('collector and backends', () => {
  const collector = read('observability/otel/collector/config.yaml');

  it('bounds memory and batches before exporting (OB-1)', () => {
    assert.match(collector, /memory_limiter:/);
    assert.match(collector, /batch:/);
    for (const pipeline of ['traces', 'metrics', 'logs']) {
      const section = new RegExp(`${pipeline}:\\n\\s+receivers:.*\\n\\s+processors: \\[memory_limiter`).test(collector);
      assert.ok(section, `${pipeline} pipeline must start with the memory limiter`);
    }
  });

  it('strips credentials from traces and logs before they leave the collector (OB-11)', () => {
    for (const key of ['http.request.header.authorization', 'http.request.header.cookie']) assert.ok(collector.includes(key));
    assert.match(collector, /traces:[\s\S]*attributes\/redact/);
    assert.match(collector, /logs:[\s\S]*attributes\/redact/);
  });

  it('probes readiness of every service and Keycloak (OB-7)', () => {
    for (const target of ['api-gateway', 'user-service', 'order-service', 'notification-worker']) assert.ok(collector.includes(`http://${target}:3000/health/ready`), target);
    assert.ok(collector.includes('http://keycloak:9000/health/ready'));
  });

  it('declares bounded retention for every store (OBN-3)', () => {
    assert.match(read('observability/tracing/tempo.yaml'), /block_retention: 48h/);
    assert.match(read('observability/logging/loki.yaml'), /retention_period: 48h/);
    assert.match(read('infrastructure/docker/docker-compose.yml'), /--storage\.tsdb\.retention\.time=2d/);
  });

  it('publishes backend ports on loopback only, and the profile keeps them opt-in (OBN-2)', () => {
    const compose = read('infrastructure/docker/docker-compose.yml');
    for (const service of ['otel-collector', 'tempo', 'loki', 'prometheus', 'grafana']) {
      const block = new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|\\nvolumes:)`).exec(compose)[1];
      assert.match(block, /profiles: \[observability\]/, `${service} must be opt-in`);
      for (const port of block.matchAll(/^\s+- "([^"]+:\d+)"$/gm)) assert.match(port[1], /^127\.0\.0\.1:/, `${service} publishes ${port[1]} beyond loopback`);
    }
  });

  it('gives Grafana a login with a placeholder password and no anonymous access (OBN-2)', () => {
    const compose = read('infrastructure/docker/docker-compose.yml');
    assert.match(compose, /GF_AUTH_ANONYMOUS_ENABLED: "false"/);
    assert.match(read('infrastructure/docker/.env.example'), /GRAFANA_ADMIN_PASSWORD=change-me/);
  });
});
