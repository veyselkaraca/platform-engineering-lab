// End to end through the public entry point: real Keycloak token -> gateway -> order-service -> RabbitMQ
// -> notification-worker, for both roles, plus the ways a caller can be refused on the way in.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { call, eventually, forgedToken, IDS, registerUser, tokens, URLS } from '../support/stack.mjs';

const gw = (path) => `${URLS.gateway}${path}`;

describe('order flow through the gateway', () => {
  let t;
  before(async () => {
    t = await tokens();
    await registerUser(t.admin, { id: IDS.customer, email: 'dev-customer@example.invalid', name: 'Dev Customer' });
  });

  const placeOrder = (token, key, userId = IDS.customer) =>
    call('POST', gw('/v1/orders'), {
      token,
      headers: { 'idempotency-key': key },
      body: { userId, amount: 42, description: 'e2e order' },
    });
  const notifications = (token, orderId) => call('GET', gw(`/v1/notifications?orderId=${orderId}`), { token });
  const waitForNotification = (orderId) =>
    eventually(async () => {
      const res = await notifications(t.customer, orderId);
      return res.status === 200 && res.body.length > 0 ? res.body : null;
    });

  it('customer: order -> idempotent replay -> exactly one notification, visible to the owner and an admin only', async () => {
    const key = `e2e-${randomUUID()}`;
    const first = await placeOrder(t.customer, key);
    assert.equal(first.status, 201);
    const orderId = first.body.id;

    const replay = await placeOrder(t.customer, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, orderId);

    const own = await waitForNotification(orderId);
    assert.equal(own.length, 1, 'the replay must not produce a second event');
    assert.equal(own[0].userId, IDS.customer);

    const asAdmin = await notifications(t.admin, orderId);
    assert.equal(asAdmin.body.length, 1);
    const asOther = await notifications(t.other, orderId);
    assert.deepEqual([asOther.status, asOther.body], [200, []], 'another customer must learn nothing');

    assert.equal((await call('GET', gw(`/v1/orders/${orderId}`), { token: t.customer })).status, 200);
    assert.equal((await call('GET', gw(`/v1/orders/${orderId}`), { token: t.admin })).status, 200);
    const foreign = await call('GET', gw(`/v1/orders/${orderId}`), { token: t.other });
    const missing = await call('GET', gw(`/v1/orders/${randomUUID()}`), { token: t.other });
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, missing.body, 'a non-owner must not be able to tell "not yours" from "does not exist"');
  });

  it('admin: places an order on behalf of the customer, who then sees the notification', async () => {
    const res = await placeOrder(t.admin, `e2e-${randomUUID()}`);
    assert.equal(res.status, 201);
    assert.equal(res.body.userId, IDS.customer);
    assert.equal((await waitForNotification(res.body.id)).length, 1);
  });

  it('another user reusing an idempotency key is refused, not handed the original order', async () => {
    const key = `e2e-${randomUUID()}`;
    assert.equal((await placeOrder(t.customer, key)).status, 201);
    const clash = await placeOrder(t.other, key, IDS.other);
    assert.equal(clash.status, 409);
    assert.equal(clash.body.userId, undefined);
  });

  it('one request id ties the gateway response to the caller', async () => {
    const res = await call('GET', gw(`/v1/users/${IDS.customer}`), { token: t.customer, headers: { 'x-request-id': 'e2e-trace-1' } });
    assert.equal(res.headers.get('x-request-id'), 'e2e-trace-1');
  });
});

describe('refusing callers at the front door and at every service', () => {
  let t;
  before(async () => {
    t = await tokens();
  });

  const targets = [
    ['gateway', (p) => gw(p)],
    ['user-service', (p) => `${URLS.user}${p}`],
    ['order-service', (p) => `${URLS.order}${p}`],
    ['notification-worker', (p) => `${URLS.worker}${p}`],
  ];
  const paths = {
    gateway: `/v1/users/${IDS.admin}`,
    'user-service': `/v1/users/${IDS.admin}`,
    'order-service': `/v1/orders/${randomUUID()}`,
    'notification-worker': `/v1/notifications?orderId=${randomUUID()}`,
  };

  for (const [name, url] of targets) {
    describe(name, () => {
      const get = (token, headers) => call('GET', url(paths[name]), { token, headers });

      it('401 without a token, with www-authenticate', async () => {
        const res = await get();
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      });

      it('401 for a token signed with an unknown key, even though issuer, audience and role look right', async () => {
        assert.equal((await get(forgedToken())).status, 401);
      });

      it('401 for alg none', async () => {
        assert.equal((await get(forgedToken({ alg: 'none' }))).status, 401);
      });

      it('401 for an expired token', async () => {
        assert.equal((await get(forgedToken({ expired: true }))).status, 401);
      });

      it('ignores identity headers supplied by the client', async () => {
        assert.equal((await get(undefined, { 'x-user-id': IDS.admin, 'x-roles': 'admin' })).status, 401);
      });

      it('keeps its probes open without a token', async () => {
        for (const probe of ['/health/live', '/health/ready']) {
          const base = url('/');
          const res = await call('GET', new URL(probe, base).href);
          assert.equal(res.status, 200, `${name}${probe}`);
        }
      });
    });
  }

  it('unknown routes stay a plain 404 at the gateway, with or without a token', async () => {
    assert.equal((await call('GET', gw('/v1/unknown'))).status, 404);
    assert.equal((await call('GET', gw('/v1/unknown'), { token: t.customer })).status, 404);
  });
});
