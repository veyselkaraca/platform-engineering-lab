// Contract between order-service and user-service: the lookup that runs with the caller's own bearer token.
// Both sides are the real services from the running stack.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { call, IDS, registerUser, tokens, URLS } from '../support/stack.mjs';

describe('user-service answers the lookup order-service depends on', () => {
  let t;
  before(async () => {
    t = await tokens();
    await registerUser(t.admin, { id: IDS.customer, email: 'dev-customer@example.invalid', name: 'Dev Customer' });
  });
  const getUser = (id, token) => call('GET', `${URLS.user}/v1/users/${id}`, { token });

  it('200 with the user shape for the caller themself', async () => {
    const res = await getUser(IDS.customer, t.customer);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['createdAt', 'email', 'id', 'name']);
  });

  it('404 for a caller whose record does not exist (order-service turns this into 422)', async () => {
    assert.equal((await getUser(IDS.other, t.other)).status, 404);
  });

  it('403 for a customer asking about someone else (order-service must never read this as "no such user")', async () => {
    assert.equal((await getUser(IDS.admin, t.customer)).status, 403);
  });

  it('200/404 for an admin asking about anyone', async () => {
    assert.equal((await getUser(IDS.customer, t.admin)).status, 200);
    assert.equal((await getUser('00000000-0000-4000-8000-00000000dead', t.admin)).status, 404);
  });
});

describe('order-service maps the lookup result correctly', () => {
  let t;
  before(async () => {
    t = await tokens();
    await registerUser(t.admin, { id: IDS.customer, email: 'dev-customer@example.invalid', name: 'Dev Customer' });
  });
  const order = (token, userId) =>
    call('POST', `${URLS.order}/v1/orders`, { token, body: { userId, amount: 12.5, description: 'contract test' } });

  it('201 when the caller has a record', async () => {
    const res = await order(t.customer, IDS.customer);
    assert.equal(res.status, 201);
    assert.equal(res.body.userId, IDS.customer);
    assert.equal(res.body.status, 'CREATED');
  });

  it('422 when the caller is a valid customer without a user record (lookup 404)', async () => {
    assert.equal((await order(t.other, IDS.other)).status, 422);
  });

  it('422 when an admin orders for an unknown user', async () => {
    assert.equal((await order(t.admin, '00000000-0000-4000-8000-00000000dead')).status, 422);
  });

  it('403 (decided before any lookup) when a customer orders for another user', async () => {
    assert.equal((await order(t.customer, IDS.other)).status, 403);
  });
});
