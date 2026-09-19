// PostgreSQL going away under the services that own a database (AGENTS.md sections 12.3, 17 and 28):
// readiness turns red so traffic is removed, liveness stays green so nothing is restarted, requests get a clean and
// fast 503 (not a 500 with a stack trace behind it), and everything recovers by itself.
// DISRUPTIVE: stops PostgreSQL of the local compose stack (Keycloak uses it too); run it on purpose:
//   node --test --test-reporter=spec --test-concurrency=1 tests/chaos/database-failures.chaos.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { docker, logsSince, status, waitReady } from '../support/compose.mjs';
import { call, eventually, IDS, registerUser, tokens, uniqueEmail, URLS } from '../support/stack.mjs';

const SERVICES = [
  ['user-service', URLS.user],
  ['order-service', URLS.order],
  ['notification-worker', URLS.worker],
];
const startedAt = (service) => {
  const id = docker('ps', '-q', service).trim();
  return execFileSync('docker', ['inspect', '-f', '{{.State.StartedAt}}', id], { encoding: 'utf8' }).trim();
};

describe('PostgreSQL down under the services that own a database', { concurrency: false }, () => {
  let t;
  before(async () => {
    docker('up', '-d', '--wait');
    t = await tokens();
    await registerUser(t.admin, { id: IDS.customer, email: 'dev-customer@example.invalid', name: 'Dev Customer' });
  });
  after(() => docker('start', 'postgres'));

  it('turns readiness red without restarting anything, answers 503 quickly and cleanly, and recovers by itself', { timeout: 300_000 }, async () => {
    // A stored order to read, and a warm baseline.
    const order = await call('POST', `${URLS.gateway}/v1/orders`, {
      token: t.customer,
      headers: { 'idempotency-key': randomUUID() },
      body: { userId: IDS.customer, amount: 3, description: 'before the outage' },
    });
    assert.equal(order.status, 201);
    const before = Object.fromEntries(SERVICES.map(([name]) => [name, startedAt(name)]));

    docker('stop', 'postgres');
    const since = new Date().toISOString();
    try {
      // Readiness reflects the hard dependency (the probe has a 2 s timeout), liveness does not.
      for (const [name, url] of SERVICES) {
        await eventually(async () => (await status(`${url}/health/ready`)) === 503, { timeoutMs: 30_000, intervalMs: 1000 });
        assert.equal(await status(`${url}/health/live`), 200, `${name}: a database outage must not make the process look dead`);
      }
      // The gateway does not depend on any backend, so it stays in rotation.
      assert.equal(await status(`${URLS.gateway}/health/ready`), 200);

      // Requests: a bounded wait, then a clean 503 without internals.
      const attempts = [
        ['GET user', () => call('GET', `${URLS.user}/v1/users/${IDS.customer}`, { token: t.customer })],
        ['POST user', () => call('POST', `${URLS.user}/v1/users`, { token: t.admin, body: { id: randomUUID(), email: uniqueEmail(), name: 'Nobody' } })],
        ['GET order', () => call('GET', `${URLS.order}/v1/orders/${order.body.id}`, { token: t.customer })],
        ['POST order', () => call('POST', `${URLS.order}/v1/orders`, { token: t.customer, body: { userId: IDS.customer, amount: 1, description: 'during the outage' } })],
        ['GET notifications', () => call('GET', `${URLS.worker}/v1/notifications?orderId=${order.body.id}`, { token: t.admin })],
      ];
      for (const [name, run] of attempts) {
        const started = Date.now();
        const res = await run();
        assert.equal(res.status, 503, `${name} while the database is down`);
        assert.ok(Date.now() - started < 10_000, `${name} took ${Date.now() - started} ms: it must not hang on a dead dependency`);
        assert.equal(res.body.statusCode, 503);
        assert.doesNotMatch(JSON.stringify(res.body), /postgres|ENOTFOUND|ECONN|typeorm|select |insert /i, `${name}: no internals in the error`);
        const requestId = res.headers.get('x-request-id');
        assert.match(logsSince(name.includes('user') ? 'user-service' : name.includes('order') ? 'order-service' : 'notification-worker', since), new RegExp(`database\\.unavailable requestId=${requestId}`));
      }

      // Everything that does not need the database keeps working: authentication is decided from cached keys.
      assert.equal((await call('GET', `${URLS.user}/v1/users/${IDS.customer}`)).status, 401);
      assert.equal((await call('POST', `${URLS.user}/v1/users`, { token: t.customer, body: {} })).status, 403);
      // The gateway simply passes the backend's honest answer through (a 503 from the backend, not a gateway 502).
      assert.equal((await call('GET', `${URLS.gateway}/v1/users/${IDS.customer}`, { token: t.customer })).status, 503);
    } finally {
      docker('start', 'postgres');
    }

    // Recovery: readiness returns and requests work again, with no restart of any service.
    for (const [, url] of SERVICES) await waitReady(url);
    await eventually(async () => (await call('GET', `${URLS.user}/v1/users/${IDS.customer}`, { token: t.customer })).status === 200, { timeoutMs: 60_000, intervalMs: 1000 });
    assert.equal((await call('GET', `${URLS.order}/v1/orders/${order.body.id}`, { token: t.customer })).status, 200);
    const again = await call('POST', `${URLS.gateway}/v1/orders`, {
      token: t.customer,
      headers: { 'idempotency-key': randomUUID() },
      body: { userId: IDS.customer, amount: 4, description: 'after the outage' },
    });
    assert.equal(again.status, 201);
    await eventually(async () => (await call('GET', `${URLS.gateway}/v1/notifications?orderId=${again.body.id}`, { token: t.admin })).body.length === 1, { timeoutMs: 60_000, intervalMs: 1000 });
    for (const [name] of SERVICES) assert.equal(startedAt(name), before[name], `${name} must not have been restarted`);
  });
});
