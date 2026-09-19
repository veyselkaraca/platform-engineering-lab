// Contract of the order.created event: what order-service really puts on the broker, checked against what
// notification-worker requires (services/notification-worker/src/messaging/order-created.event.ts).
// A spy queue bound to the `orders` exchange receives a copy of every event, next to the worker's own queue.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createSpyQueue, deleteQueue, peek } from '../support/broker.mjs';
import { call, eventually, IDS, registerUser, tokens, URLS } from '../support/stack.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('order.created as published by order-service', () => {
  let t;
  let spy;
  before(async () => {
    t = await tokens();
    await registerUser(t.admin, { id: IDS.customer, email: 'dev-customer@example.invalid', name: 'Dev Customer' });
    spy = await createSpyQueue();
  });
  after(() => deleteQueue(spy));

  const order = (body, headers = {}) =>
    call('POST', `${URLS.gateway}/v1/orders`, { token: t.customer, body: { userId: IDS.customer, amount: 42, description: 'contract order', ...body }, headers });
  const eventsFor = async (correlationId) => (await peek(spy)).filter((m) => m.properties.correlation_id === correlationId);

  it('carries the envelope, message properties and payload the worker depends on', async () => {
    const correlationId = `contract-${randomUUID()}`;
    const res = await order({}, { 'x-request-id': correlationId, 'idempotency-key': randomUUID() });
    assert.equal(res.status, 201);

    const [message] = await eventually(async () => {
      const found = await eventsFor(correlationId);
      return found.length > 0 ? found : null;
    }, { timeoutMs: 10_000 });

    // Message properties: durable, typed, and addressable by the ids the worker logs and dedupes on.
    const p = message.properties;
    assert.equal(p.delivery_mode, 2, 'persistent');
    assert.equal(p.content_type, 'application/json');
    assert.equal(p.type, 'order.created');
    assert.equal(p.correlation_id, correlationId, 'the request id becomes the correlation id (end-to-end correlation)');
    assert.ok(Number.isInteger(p.timestamp));

    // Envelope and data: exactly what parseOrderCreated reads, plus the order facts consumers may use.
    const event = JSON.parse(message.payload);
    assert.deepEqual(Object.keys(event).sort(), ['correlationId', 'data', 'eventId', 'occurredAt', 'type']);
    assert.match(event.eventId, UUID);
    assert.equal(p.message_id, event.eventId, 'message_id equals eventId');
    assert.equal(event.type, 'order.created');
    assert.equal(event.correlationId, correlationId);
    assert.ok(Math.abs(Date.now() - Date.parse(event.occurredAt)) < 60_000, 'occurredAt is an ISO timestamp for now');
    assert.equal(new Date(event.occurredAt).toISOString(), event.occurredAt);
    assert.deepEqual(Object.keys(event.data).sort(), ['amount', 'description', 'orderId', 'userId']);
    assert.equal(event.data.orderId, res.body.id);
    assert.equal(event.data.userId, IDS.customer);
    assert.equal(event.data.amount, 42);
    assert.equal(event.data.description, 'contract order');
  });

  it('is accepted by the worker: the notification exists, tied to the same order and user', async () => {
    const res = await order({}, { 'idempotency-key': randomUUID() });
    const notifications = await eventually(async () => {
      const r = await call('GET', `${URLS.gateway}/v1/notifications?orderId=${res.body.id}`, { token: t.admin });
      return r.body.length > 0 ? r.body : null;
    });
    assert.equal(notifications[0].orderId, res.body.id);
    assert.equal(notifications[0].userId, IDS.customer);
  });

  it('is published once per order: an idempotent replay emits nothing new', async () => {
    const correlationId = `contract-${randomUUID()}`;
    const key = randomUUID();
    assert.equal((await order({}, { 'x-request-id': correlationId, 'idempotency-key': key })).status, 201);
    await eventually(async () => (await eventsFor(correlationId)).length === 1);

    const replay = await order({}, { 'x-request-id': correlationId, 'idempotency-key': key });
    assert.equal(replay.status, 200);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await eventsFor(correlationId)).length, 1);
  });

  it('is not published for an order that was rejected', async () => {
    const correlationId = `contract-${randomUUID()}`;
    const res = await call('POST', `${URLS.order}/v1/orders`, {
      token: t.admin,
      headers: { 'x-request-id': correlationId },
      body: { userId: '00000000-0000-4000-8000-00000000dead', amount: 1, description: 'unknown user' },
    });
    assert.equal(res.status, 422);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await eventsFor(correlationId)).length, 0);
  });
});
