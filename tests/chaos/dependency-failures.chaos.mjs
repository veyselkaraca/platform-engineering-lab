// Failure behavior of the synchronous path against the real stack (engineering standards: Reliability, Redis, Failure and recovery):
// Redis (a cache, never authoritative) and user-service (a hard dependency of order creation) going away.
// DISRUPTIVE: stops and restarts Redis and user-service of the local compose stack; run it on purpose:
//   node --test --test-reporter=spec --test-concurrency=1 tests/chaos/dependency-failures.chaos.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { countMatches, docker, logsSince, psql, sleep, waitReady } from '../support/compose.mjs';
import { call, eventually, IDS, registerUser, tokens, uniqueEmail, URLS } from '../support/stack.mjs';

const cacheTtl = (userId) => Number(docker('exec', '-T', 'redis', 'redis-cli', 'TTL', `user:${userId}`).trim()); // -2: no such key

describe('sync path under failure', { concurrency: false }, () => {
  let t;
  const place = (token, userId = IDS.customer, url = URLS.gateway) =>
    call('POST', `${url}/v1/orders`, { token, headers: { 'idempotency-key': randomUUID() }, body: { userId, amount: 9, description: 'dependency failure' } });

  before(async () => {
    docker('up', '-d', '--wait');
    t = await tokens();
    await registerUser(t.admin, { id: IDS.customer, email: 'dev-customer@example.invalid', name: 'Dev Customer' });
  });
  after(() => {
    // Leave the stack as found.
    docker('start', 'redis');
    docker('start', 'user-service');
  });

  it('Redis down: orders still succeed through the fallback, quickly and with one warning; the cache comes back by itself', { timeout: 180_000 }, async () => {
    const baseline = await place(t.customer);
    assert.equal(baseline.status, 201);
    await eventually(() => cacheTtl(IDS.customer) > 0, { timeoutMs: 5000, intervalMs: 250 }); // the cache was in use

    const since = new Date().toISOString();
    docker('stop', 'redis');
    try {
      let last;
      for (let i = 0; i < 4; i++) {
        const started = Date.now();
        last = await place(t.customer);
        assert.equal(last.status, 201, 'a cache outage must not fail order creation (NFR-4)');
        assert.ok(Date.now() - started < 4000, `order ${i + 1} took ${Date.now() - started} ms: Redis must fail fast, not stall the request`);
      }
      assert.equal(await call('GET', `${URLS.order}/health/ready`).then((r) => r.status), 200, 'Redis is not part of readiness');

      // The client notices the outage on its first reconnect attempt, so wait for the line, then give further
      // attempts time to (not) repeat it.
      const warned = () => countMatches(logsSince('order-service', since), 'Redis unavailable, falling back to source of truth');
      await eventually(() => warned() >= 1, { timeoutMs: 15_000, intervalMs: 500 });
      await sleep(4000);
      assert.equal(warned(), 1, 'an outage is one log line, not one per request or reconnect attempt');

      // The rest of the flow is unaffected: the event still reaches the worker.
      await eventually(async () => (await call('GET', `${URLS.gateway}/v1/notifications?orderId=${last.body.id}`, { token: t.admin })).body.length === 1, { timeoutMs: 30_000 });
    } finally {
      docker('start', 'redis'); // never leave the stack broken for the next test
    }

    await eventually(() => logsSince('order-service', since).includes('Redis connection restored'), { timeoutMs: 30_000, intervalMs: 1000 });
    assert.equal((await place(t.customer)).status, 201);
    await eventually(() => cacheTtl(IDS.customer) > 0, { timeoutMs: 10_000, intervalMs: 500 }); // caching resumed without a restart
  });

  it('user-service down: cached users keep ordering, others get a fast 503 and nothing is stored, the gateway isolates the route, and it recovers by itself', { timeout: 240_000 }, async () => {
    // A user record order-service has never looked up (so it is not cached), and one it just cached.
    const uncached = randomUUID();
    const created = await call('POST', `${URLS.user}/v1/users`, { token: t.admin, body: { id: uncached, email: uniqueEmail(), name: 'Never looked up' } });
    assert.equal(created.status, 201);
    const warm = await place(t.customer);
    assert.equal(warm.status, 201);
    await eventually(() => cacheTtl(IDS.customer) > 0, { timeoutMs: 5000, intervalMs: 250 });

    docker('stop', 'user-service');
    const since = new Date().toISOString();

    // Inside the cache TTL a cached user is not affected at all.
    assert.equal((await place(t.customer)).status, 201);

    // Anyone else needs the lookup: bounded wait (2 s timeout, one retry), then 503, and no order is stored.
    const started = Date.now();
    const refused = await place(t.admin, uncached);
    assert.equal(refused.status, 503);
    assert.ok(Date.now() - started < 8000, `the 503 took ${Date.now() - started} ms: every network dependency needs an explicit timeout`);
    assert.doesNotMatch(JSON.stringify(refused.body), /user-service|:3000|ECONN|ENOTFOUND/, 'no internals in the error');
    assert.match(logsSince('order-service', since), new RegExp(`user lookup failed requestId=${refused.headers.get('x-request-id')}`));
    assert.equal(psql('order_service', `SELECT count(*) FROM orders WHERE user_id = '${uncached}'`), '0');

    // Isolation at the front door: only the user route breaks. Readiness is independent of backends.
    const viaGateway = await call('GET', `${URLS.gateway}/v1/users/${IDS.customer}`, { token: t.customer });
    assert.equal(viaGateway.status, 502);
    assert.doesNotMatch(JSON.stringify(viaGateway.body), /user-service|:3000|ECONN|ENOTFOUND/);
    assert.equal((await call('GET', `${URLS.gateway}/v1/orders/${warm.body.id}`, { token: t.customer })).status, 200);
    assert.equal((await call('GET', `${URLS.gateway}/health/ready`)).status, 200);
    assert.equal((await call('GET', `${URLS.order}/health/ready`)).status, 200, 'user-service is not part of order-service readiness');

    // Recovery: no restart of order-service or the gateway.
    docker('start', 'user-service');
    await waitReady(URLS.user);
    const recovered = await eventually(async () => {
      const res = await place(t.admin, uncached);
      return res.status === 201 ? res : null;
    }, { timeoutMs: 60_000, intervalMs: 1000 });
    assert.equal(recovered.body.userId, uncached);
    assert.equal((await call('GET', `${URLS.gateway}/v1/users/${IDS.customer}`, { token: t.customer })).status, 200);
  });
});
