// notification-worker's consumer against the real broker and database: what the unit tests can only mock.
// Messages go through the real `orders` exchange, exactly like order-service's, without going through an order.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { DLQ, MAIN_QUEUE, RETRY_QUEUE, orderCreatedEvent, peek, publish, publishEvent, queueInfo, takeMatching } from '../support/broker.mjs';
import { call, eventually, tokens, URLS } from '../support/stack.mjs';

describe('notification-worker consumer', () => {
  let t;
  const dlqIds = new Set(); // everything this file dead-letters is removed again, and nothing else
  before(async () => {
    t = await tokens();
  });
  after(async () => {
    if (dlqIds.size > 0) await takeMatching(DLQ, (m) => dlqIds.has(m.properties.message_id));
  });

  const notificationsFor = async (orderId) => (await call('GET', `${URLS.worker}/v1/notifications?orderId=${orderId}`, { token: t.admin })).body;
  const stored = (orderId) => eventually(async () => {
    const rows = await notificationsFor(orderId);
    return rows.length > 0 ? rows : null;
  });
  const inDlq = (messageId) => eventually(async () => (await peek(DLQ)).find((m) => m.properties.message_id === messageId) ?? null, { timeoutMs: 15_000 });
  const isIn = async (queue, messageId) => (await peek(queue)).some((m) => m.properties.message_id === messageId);

  it('has a consumer on the main queue, and the retry queue and DLQ exist and are not consumed', async () => {
    assert.ok((await queueInfo(MAIN_QUEUE)).consumers >= 1);
    for (const q of [RETRY_QUEUE, DLQ]) assert.equal((await queueInfo(q)).consumers, 0, q);
  });

  it('stores a notification for a valid event, tied to its order and user', async () => {
    const event = await publishEvent(orderCreatedEvent());
    const [row] = await stored(event.data.orderId);
    assert.equal(row.eventId, event.eventId);
    assert.equal(row.orderId, event.data.orderId);
    assert.equal(row.userId, event.data.userId);
  });

  it('is idempotent: the same event delivered several times yields one notification (FR-7)', async () => {
    const event = orderCreatedEvent();
    await publishEvent(event);
    await publishEvent(event);
    await publishEvent(event);
    await stored(event.data.orderId);
    await new Promise((r) => setTimeout(r, 1500)); // let the duplicates be consumed
    assert.equal((await notificationsFor(event.data.orderId)).length, 1);
  });

  const poison = [
    ['a body that is not JSON', () => 'this is not json', /not valid JSON/],
    ['a JSON body that is not an object', () => JSON.stringify('order'), /must be an object/],
    ['another event type', () => JSON.stringify({ ...orderCreatedEvent(), type: 'order.cancelled' }), /unexpected event type/],
    ['an eventId that is not a UUID', () => JSON.stringify({ ...orderCreatedEvent(), eventId: 'evt-1' }), /eventId must be a UUID/],
    ['a missing order id', () => JSON.stringify({ ...orderCreatedEvent(), data: { userId: randomUUID() } }), /data\.orderId must be a UUID/],
  ];
  for (const [name, make, reason] of poison) {
    it(`dead-letters ${name} at once, with its reason, without retrying it`, async () => {
      const messageId = randomUUID();
      dlqIds.add(messageId);
      await publish(make(), { messageId, correlationId: `bt-${messageId}` });

      const dead = await inDlq(messageId);
      assert.match(dead.properties.headers['x-failure-reason'], /^permanent failure: /);
      assert.match(dead.properties.headers['x-failure-reason'], reason);
      assert.equal(dead.properties.headers['x-failed-attempts'], 1);
      assert.equal(dead.properties.correlation_id, `bt-${messageId}`, 'correlation survives dead-lettering');
      assert.equal(await isIn(RETRY_QUEUE, messageId), false, 'a malformed message must never enter the retry loop');
    });
  }

  it('is not blocked by a poison message: the valid event right behind it is processed', async () => {
    const messageId = randomUUID();
    dlqIds.add(messageId);
    await publish('garbage', { messageId });
    const event = await publishEvent(orderCreatedEvent());
    assert.equal((await stored(event.data.orderId)).length, 1);
    await inDlq(messageId);
  });

  it('leaves nothing unacknowledged once idle (every message was acked or dead-lettered)', async () => {
    // The management statistics refresh every few seconds, hence "eventually".
    await eventually(async () => {
      const q = await queueInfo(MAIN_QUEUE);
      return q.messages === 0 && q.messages_unacknowledged === 0;
    }, { timeoutMs: 20_000, intervalMs: 1000 });
  });
});
