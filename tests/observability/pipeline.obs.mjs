// The telemetry pipeline against the running observability stack (docs/features/observability/TEST-PLAN.md).
// Needs the stack with the observability profile; not part of the regular test glob:
//   node --test --test-reporter=spec --test-concurrency=1 tests/observability/pipeline.obs.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { before, describe, it } from 'node:test';
import { repoRoot } from '../support/broker.mjs';
import { grafana, lokiLines, newTrace, promAlerts, promQuery, promScalar, tempoSpans } from '../support/observability.mjs';
import { call, eventually, IDS, registerUser, tokens, URLS } from '../support/stack.mjs';

const SERVICES = ['api-gateway', 'user-service', 'order-service', 'notification-worker'];

describe('one order, seen through traces, logs and metrics', () => {
  let t;
  let trace; // the trace of the order placed below
  let order;
  const description = `secret-description-${randomUUID()}`; // must never appear in telemetry as a SQL parameter value
  const unauthenticatedBefore = {};

  before(async () => {
    t = await tokens();
    await registerUser(t.admin, { id: IDS.customer, email: 'dev-customer@example.invalid', name: 'Dev Customer' });
    unauthenticatedBefore.missing = await promScalar('sum(auth_rejections_total{reason="missing"})');
    trace = newTrace();
    order = await call('POST', `${URLS.gateway}/v1/orders`, {
      token: t.customer,
      headers: { traceparent: trace.traceparent, 'idempotency-key': randomUUID(), 'x-request-id': `obs-${trace.traceId}` },
      body: { userId: IDS.customer, amount: 11, description },
    });
    assert.equal(order.status, 201);
    await call('GET', `${URLS.gateway}/v1/users/${IDS.customer}`); // no token: a refusal to count
    await call('GET', `${URLS.gateway}/health/ready`, { headers: { traceparent: newTrace().traceparent } });
  });

  describe('traces (OB-2)', () => {
    let spans;
    before(async () => {
      // Tempo needs a moment; the worker's spans arrive after the asynchronous hop.
      spans = await eventually(async () => {
        const s = await tempoSpans(trace.traceId);
        return s && SERVICES.every((svc) => s.some((x) => x.service === svc)) ? s : null;
      }, { timeoutMs: 90_000, intervalMs: 3000 });
    });

    it('is a single trace across the gateway, order-service, user-service and notification-worker', () => {
      for (const svc of SERVICES) assert.ok(spans.some((s) => s.service === svc), `no span from ${svc}`);
    });

    it('honors the traceparent the client sent', () => {
      const root = spans.find((s) => s.service === 'api-gateway' && s.kind === 'SPAN_KIND_SERVER');
      assert.ok(root, 'the gateway has a server span');
      assert.equal(root.raw.parentSpanId, Buffer.from(trace.traceparent.split('-')[2], 'hex').toString('base64'));
    });

    it('continues across RabbitMQ: a publish span in order-service and a consume span in the worker, same trace', () => {
      assert.ok(spans.some((s) => s.service === 'order-service' && s.kind === 'SPAN_KIND_PRODUCER'));
      assert.ok(spans.some((s) => s.service === 'notification-worker' && s.kind === 'SPAN_KIND_CONSUMER'));
    });

    it('covers the dependencies: user lookup over HTTP, database and cache calls', () => {
      assert.ok(spans.some((s) => s.service === 'order-service' && s.kind === 'SPAN_KIND_CLIENT' && s.attributes['url.full']?.includes('user-service')));
      assert.ok(spans.some((s) => s.service === 'order-service' && s.name.startsWith('pg.query')));
      assert.ok(spans.some((s) => s.service === 'notification-worker' && s.name.startsWith('pg.query')));
      assert.ok(spans.some((s) => s.service === 'order-service' && ['get', 'set'].includes(s.name)));
    });

    it('records no credentials and no SQL parameter values (OB-11)', () => {
      const everything = JSON.stringify(spans.map((s) => s.raw));
      assert.ok(!everything.includes(t.customer.slice(0, 40)), 'the bearer token is in a span');
      assert.doesNotMatch(everything, /authorization/i);
      assert.ok(!everything.includes(description), 'a SQL parameter value is in a span');
    });

    it('does not trace health probes (OB-3)', async () => {
      const probe = newTrace();
      await call('GET', `${URLS.order}/health/ready`, { headers: { traceparent: probe.traceparent } });
      await new Promise((r) => setTimeout(r, 12_000));
      assert.equal(await tempoSpans(probe.traceId), null);
    });
  });

  describe('logs (OB-3)', () => {
    let lines;
    before(async () => {
      lines = await eventually(async () => {
        const found = await lokiLines(`{service_name=~".+"} | trace_id="${trace.traceId}"`);
        return SERVICES.every((svc) => found.some((l) => l.service === svc)) ? found : null;
      }, { timeoutMs: 90_000, intervalMs: 3000 });
    });

    it('every service logged this request under the same trace id', () => {
      for (const svc of SERVICES) assert.ok(lines.some((l) => l.service === svc), `no log line from ${svc}`);
    });

    it('lines carry trace_id and span_id, and the request id survives', () => {
      for (const l of lines) {
        assert.equal(l.labels.trace_id, trace.traceId);
        assert.match(l.labels.span_id, /^[0-9a-f]{16}$/);
      }
      assert.ok(lines.some((l) => l.labels.req_id === `obs-${trace.traceId}` || l.line.includes(`obs-${trace.traceId}`)), 'the x-request-id is not in the logs');
    });

    it('never contain the token or the Authorization header value (OB-11)', async () => {
      const marker = t.customer.slice(20, 60); // a stretch of the token, not the (guessable) JWT header
      const leaked = await lokiLines(`{service_name=~".+"} |= "${marker}"`);
      assert.equal(leaked.length, 0);
      const bearer = await lokiLines('{service_name=~".+"} |~ "(?i)bearer ey"');
      assert.equal(bearer.length, 0);
    });

    it('are reachable by service and level for the dashboards', async () => {
      const found = await lokiLines('{service_name="order-service"}', 30);
      assert.ok(found.length > 0);
    });
  });

  describe('metrics (OB-4 to OB-7)', () => {
    it('HTTP server metrics per service, with the route template and without probe traffic', async () => {
      await eventually(async () => (await promQuery('count(count by (service_name) (http_server_request_duration_seconds_count))'))[0]?.value[1] >= 4, { timeoutMs: 60_000, intervalMs: 3000 });
      const seen = (await promQuery('sum by (service_name) (http_server_request_duration_seconds_count)')).map((r) => r.metric.service_name);
      for (const svc of SERVICES) assert.ok(seen.includes(svc), `no HTTP metrics for ${svc}`);
      const routes = (await promQuery('count by (http_route) (http_server_request_duration_seconds_count)')).map((r) => r.metric.http_route);
      assert.ok(routes.includes('/v1/orders'), 'the gateway labels requests by route prefix');
      assert.ok(routes.includes('/v1/users/:id'), 'services label requests by route template, not by raw URL');
      assert.ok(!routes.some((r) => r?.startsWith('/health')), 'probe traffic must not be measured');
      assert.ok(!routes.some((r) => /[0-9a-f]{8}-[0-9a-f]{4}/.test(r ?? '')), 'no ids in labels (cardinality)');
    });

    it('resource use per service', async () => {
      await eventually(async () => (await promQuery('count(process_memory_usage_bytes)'))[0]?.value[1] >= 4, { timeoutMs: 60_000, intervalMs: 3000 });
      for (const q of ['process_memory_usage_bytes', 'process_cpu_time_seconds_total', 'nodejs_eventloop_delay_p99_seconds']) {
        const services = (await promQuery(`count by (service_name) (${q})`)).map((r) => r.metric.service_name);
        for (const svc of SERVICES) assert.ok(services.includes(svc), `${q} missing for ${svc}`);
      }
    });

    it('worker outcomes and the order counter follow the order that was placed', async () => {
      await eventually(async () => (await promScalar('sum(notification_messages_total{outcome="processed"})')) >= 1, { timeoutMs: 60_000, intervalMs: 3000 });
      assert.ok((await promScalar('sum(orders_created_total)')) >= 1);
      assert.ok((await promScalar('sum(notification_processing_duration_seconds_count)')) >= 1);
    });

    it('lookup and cache counters from order-service', async () => {
      await eventually(async () => (await promScalar('sum(user_lookups_total)')) >= 1 && (await promScalar('sum(cache_operations_total)')) >= 1, { timeoutMs: 60_000, intervalMs: 3000 });
    });

    it('counts the refusal of the unauthenticated call by reason (IDN-7)', async () => {
      await eventually(async () => (await promScalar('sum(auth_rejections_total{reason="missing"})')) > unauthenticatedBefore.missing, { timeoutMs: 60_000, intervalMs: 3000 });
    });

    it('broker queue depth, consumers and DLQ depth come from RabbitMQ itself (OB-5)', async () => {
      const queues = (await promQuery('count by (queue) (rabbitmq_detailed_queue_messages_ready)')).map((r) => r.metric.queue);
      for (const q of ['notification.order-created', 'notification.order-created.retry', 'notification.order-created.dlq']) assert.ok(queues.includes(q), q);
      assert.equal(await promScalar('max(rabbitmq_detailed_queue_consumers{queue="notification.order-created"})'), 1);
    });

    it('readiness of every service, Keycloak included, is a metric, and all are ready (OB-7)', async () => {
      const ready = await eventually(async () => {
        const r = await promQuery('min by (http_url) (httpcheck_status{http_status_class="2xx", http_url=~".*/health/ready"})');
        return r.length >= 5 ? r : null;
      }, { timeoutMs: 60_000, intervalMs: 3000 });
      const urls = ready.map((r) => r.metric.http_url).join(' ');
      for (const svc of [...SERVICES, 'keycloak']) assert.match(urls, new RegExp(svc));
      for (const r of ready) assert.equal(r.value[1], '1', `${r.metric.http_url} is not ready`);
    });
  });
});

describe('dashboards, alert rules and datasources are provisioned (OB-8, OB-9, OBN-4)', () => {
  it('Prometheus, Tempo and Loki are healthy datasources in Grafana', async () => {
    for (const uid of ['prometheus', 'tempo', 'loki']) {
      const res = await grafana(`/api/datasources/uid/${uid}/health`);
      assert.equal(res.status, 200, `${uid}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.status, 'OK', uid);
    }
  });

  it('cross-links exist: logs to traces (derived field) and traces to logs', async () => {
    const loki = (await grafana('/api/datasources/uid/loki')).body;
    assert.equal(loki.jsonData.derivedFields[0].datasourceUid, 'tempo');
    const tempo = (await grafana('/api/datasources/uid/tempo')).body;
    assert.equal(tempo.jsonData.tracesToLogsV2.datasourceUid, 'loki');
    assert.equal(tempo.jsonData.tracesToLogsV2.filterByTraceID, true);
  });

  it('Grafana requires a login: no anonymous access (OBN-2)', async () => {
    const res = await fetch(`${process.env.GRAFANA_URL ?? 'http://localhost:3000'}/api/search`);
    assert.equal(res.status, 401);
  });

  it('both dashboards are loaded, and every Prometheus query in them is valid against the live server', async () => {
    const found = (await grafana('/api/search?type=dash-db')).body.map((d) => d.uid);
    assert.ok(found.includes('platform-health') && found.includes('application-health'));
    const dir = resolve(repoRoot, 'observability/grafana/dashboards');
    let queries = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const dashboard = JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
      for (const panel of dashboard.panels.filter((p) => p.datasource?.uid === 'prometheus')) {
        for (const target of panel.targets) {
          const expr = target.expr.replaceAll('$__rate_interval', '1m').replaceAll('$service', '.*');
          await promQuery(expr); // throws on a syntax error
          queries++;
        }
      }
    }
    assert.ok(queries > 30, `only ${queries} queries checked`);
  });

  it('every alert rule is loaded and healthy, with a severity and a runbook', async () => {
    const res = await fetch(`${process.env.PROMETHEUS_URL ?? 'http://localhost:9090'}/api/v1/rules`);
    const groups = (await res.json()).data.groups;
    const alerts = groups.flatMap((g) => g.rules).filter((r) => r.type === 'alerting');
    const names = alerts.map((a) => a.name);
    for (const expected of ['ServiceNotReady', 'HighErrorRate', 'HighLatency', 'DeadLetterQueueNotEmpty', 'WorkerNotConsuming', 'QueueBacklogGrowing', 'OrderEventsNotPublished', 'DatabaseUnavailable', 'AuthenticationKeysUnavailable', 'GatewayAvailabilityFastBurn', 'GatewayAvailabilitySlowBurn', 'GatewayLatencyFastBurn', 'TelemetryPipelineDown']) {
      assert.ok(names.includes(expected), `${expected} is not loaded`);
    }
    for (const a of alerts) {
      assert.equal(a.health, 'ok', a.name);
      assert.ok(a.labels.severity, `${a.name} has no severity`);
      assert.ok(a.annotations.runbook, `${a.name} has no runbook`);
    }
    assert.equal((await promAlerts()).filter((x) => x.state === 'firing').length, 0, 'a healthy stack must not have firing alerts');
  });

  it('the SLI recording rules produce values for the gateway', async () => {
    await eventually(async () => (await promQuery('sli:gateway_error_ratio:rate5m')).length > 0, { timeoutMs: 60_000, intervalMs: 3000 });
  });
});
