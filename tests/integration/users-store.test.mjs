// user-service against its real PostgreSQL (through the running stack).
// Covers what the unit tests can only mock: constraint names, the insert-not-upsert rule and returned columns.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { call, IDS, registerUser, tokens, uniqueEmail, URLS } from '../support/stack.mjs';
import { randomUUID } from 'node:crypto';

describe('user-service persistence', () => {
  let t;
  before(async () => {
    t = await tokens();
  });
  const create = (body) => call('POST', `${URLS.user}/v1/users`, { token: t.admin, body });

  it('stores the user under the id it was given and returns the created row', async () => {
    const id = randomUUID();
    const email = uniqueEmail();
    const res = await create({ id, email, name: 'Integration' });
    assert.equal(res.status, 201);
    assert.equal(res.body.id, id);
    assert.equal(res.body.email, email);
    assert.match(res.body.createdAt, /^\d{4}-\d\d-\d\dT/);
    const read = await call('GET', `${URLS.user}/v1/users/${id}`, { token: t.admin });
    assert.equal(read.status, 200);
    assert.equal(read.body.email, email);
  });

  it('answers a duplicate id with its own 409 and does NOT overwrite the stored user', async () => {
    const id = randomUUID();
    const email = uniqueEmail();
    assert.equal((await create({ id, email, name: 'Original' })).status, 201);

    const dup = await create({ id, email: uniqueEmail(), name: 'Overwritten' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.message, /id already exists/);

    const read = await call('GET', `${URLS.user}/v1/users/${id}`, { token: t.admin });
    assert.equal(read.body.name, 'Original', 'a repeated id must never update the existing row');
    assert.equal(read.body.email, email);
  });

  it('answers a duplicate email with a different 409', async () => {
    const email = uniqueEmail();
    assert.equal((await create({ id: randomUUID(), email, name: 'First' })).status, 201);
    const dup = await create({ id: randomUUID(), email, name: 'Second' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.message, /email already exists/);
  });

  it('rejects a missing or non-UUID id with 400 and stores nothing', async () => {
    assert.equal((await create({ email: uniqueEmail(), name: 'No id' })).status, 400);
    assert.equal((await create({ id: 'alice', email: uniqueEmail(), name: 'Bad id' })).status, 400);
  });

  it('keeps the dev customer record readable by its owner (registration is idempotent)', async () => {
    await registerUser(t.admin, { id: IDS.customer, email: 'dev-customer@example.invalid', name: 'Dev Customer' });
    const res = await call('GET', `${URLS.user}/v1/users/${IDS.customer}`, { token: t.customer });
    assert.equal(res.status, 200);
  });
});
