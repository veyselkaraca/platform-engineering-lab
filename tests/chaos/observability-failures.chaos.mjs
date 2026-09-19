// Failure behavior of observability itself, and alerts that must fire when the platform breaks
// (docs/features/observability: OB-1, OB-9, OBN-7). Needs the stack with the observability profile.
// DISRUPTIVE and slow (alerts have a `for:` delay): stops the collector, user-service, the worker and adds a poison
// message to the DLQ, then restores everything. About ten minutes. Run it on purpose:
//   node --test --test-reporter=spec --test-concurrency=1 tests/chaos/observability-failures.chaos.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { DLQ, peek, publish, takeMatching } from '../support/broker.mjs';
import { docker, logsSince, waitReady } from '../support/compose.mjs';
import { newTrace, promAlerts, promScalar, tempoSpans } from '../support/observability.mjs';
import { call, eventually, IDS, registerUser, tokens, URLS } from '../support/stack.mjs';

const PROFILE = ['--profile', 'observability'];
const alert = async (name, match = () => true) => (await promAlerts()).find((a) => a.labels.alertname === name && match(a.labels));
const firing = async (name, match) => (await alert(name, match))?.state === 'firing';
const gone = async (name, match) => (await alert(name, match)) === undefined;

describe('observability under failure, and alerts firing for real failures', { concurrency: false }, () => {
  let t;
  const placeOrder = (headers = {}) =>
    call('POST', `${URLS.gateway}/v1/orders`, {
      token: t.customer,
      headers: { 'idempotency-key': randomUUID(), ...headers },
      body: { userId: IDS.customer, amount: 6, description: 'observability chaos' },
    });

  before(async () => {
    docker(...PROFILE, 'up', '-d', '--wait');
    t = await tokens();
    await registerUser(t.admin, { id: IDS.customer, email: 'dev-customer@example.invalid', name: 'Dev Customer' });
    await eventually(async () => (await promAlerts()).filter((a) => a.state === 'firing').length === 0, { timeoutMs: 120_000, intervalMs: 5000 }); // start clean
  });
  after(() => {
    for (const service of ['otel-collector', 'user-service', 'notification-worker']) docker(...PROFILE, 'start', service);
  });

  it('the collector down: requests and stdout logs are unaffected, the outage is alerted, and telemetry resumes by itself (OB-1, OBN-7)', { timeout: 600_000 }, async () => {
    docker(...PROFILE, 'stop', 'otel-collector');
    const since = new Date().toISOString();
    try {
      const outage = newTrace();
      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        const res = await placeOrder(i === 0 ? { traceparent: outage.traceparent, 'x-request-id': `during-outage-${outage.traceId}` } : {});
        assert.equal(res.status, 201, 'a dead collector must not fail requests');
        assert.ok(Date.now() - started < 2500, `an order took ${Date.now() - started} ms with the collector down: telemetry must never block a request`);
      }
      for (const url of [URLS.gateway, URLS.order, URLS.user, URLS.worker]) assert.equal((await call('GET', `${url}/health/ready`)).status, 200);
      // The container's stdout logs do not depend on the collector.
      assert.match(logsSince('order-service', since), new RegExp(`during-outage-${outage.traceId}`));

      await eventually(() => firing('TelemetryPipelineDown', (l) => l.job === 'otel-collector'), { timeoutMs: 240_000, intervalMs: 10_000 });
    } finally {
      docker(...PROFILE, 'start', 'otel-collector');
    }

    // Resumes without restarting any service: a new request is traced end to end again, and its metrics arrive.
    const before = await promScalar('sum(http_server_request_duration_seconds_count{service_name="api-gateway"})');
    const trace = newTrace();
    await eventually(async () => {
      const res = await placeOrder({ traceparent: trace.traceparent });
      return res.status === 201;
    }, { timeoutMs: 60_000, intervalMs: 2000 });
    await eventually(async () => {
      const spans = await tempoSpans(trace.traceId);
      return spans && ['api-gateway', 'order-service', 'user-service'].every((svc) => spans.some((s) => s.service === svc));
    }, { timeoutMs: 90_000, intervalMs: 3000 });
    await eventually(async () => (await promScalar('sum(http_server_request_duration_seconds_count{service_name="api-gateway"})')) > before, { timeoutMs: 90_000, intervalMs: 3000 });
    await eventually(() => gone('TelemetryPipelineDown'), { timeoutMs: 180_000, intervalMs: 10_000 });
  });

  it('a service and the worker stopped: ServiceNotReady and WorkerNotConsuming fire, and clear when they are back (OB-9)', { timeout: 600_000 }, async () => {
    docker(...PROFILE, 'stop', 'user-service', 'notification-worker');
    try {
      await eventually(() => firing('ServiceNotReady', (l) => l.http_url.includes('user-service')), { timeoutMs: 240_000, intervalMs: 10_000 });
      await eventually(() => firing('ServiceNotReady', (l) => l.http_url.includes('notification-worker')), { timeoutMs: 120_000, intervalMs: 10_000 });
      await eventually(() => firing('WorkerNotConsuming'), { timeoutMs: 240_000, intervalMs: 10_000 });
      // The alert carries what an operator needs.
      const a = await alert('ServiceNotReady', (l) => l.http_url.includes('user-service'));
      assert.equal(a.labels.severity, 'critical');
      assert.match(a.annotations.runbook, /service-alerts\.md#servicenotready/);
    } finally {
      docker(...PROFILE, 'start', 'user-service', 'notification-worker');
    }
    await waitReady(URLS.user);
    await waitReady(URLS.worker);
    await eventually(async () => (await gone('ServiceNotReady')) && (await gone('WorkerNotConsuming')), { timeoutMs: 240_000, intervalMs: 10_000 });
  });

  it('a dead-lettered message fires DeadLetterQueueNotEmpty, and removing it clears the alert (OB-5, OB-9)', { timeout: 600_000 }, async () => {
    const messageId = randomUUID();
    await publish('poison for the alert test', { messageId, correlationId: `obs-${messageId}` });
    try {
      await eventually(async () => (await peek(DLQ)).some((m) => m.properties.message_id === messageId), { timeoutMs: 30_000, intervalMs: 1000 });
      await eventually(async () => (await promScalar('sum(rabbitmq_detailed_queue_messages_ready{queue=~".*\\\\.dlq"})')) >= 1, { timeoutMs: 90_000, intervalMs: 5000 });
      await eventually(() => firing('DeadLetterQueueNotEmpty', (l) => l.queue === DLQ), { timeoutMs: 180_000, intervalMs: 10_000 });
      // The worker counted it as dead-lettered.
      assert.ok((await promScalar('sum(notification_messages_total{outcome="dead_lettered"})')) >= 1);
    } finally {
      await takeMatching(DLQ, (m) => m.properties.message_id === messageId);
    }
    await eventually(() => gone('DeadLetterQueueNotEmpty'), { timeoutMs: 180_000, intervalMs: 10_000 });
  });
});
