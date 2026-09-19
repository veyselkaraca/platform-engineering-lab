// RabbitMQ helpers for the broker tests, over the management HTTP API (zero dependencies).
// Credentials come from the environment or from the git-ignored infrastructure/docker/.env; they are never printed.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dirname, '../..');

function credentials() {
  let user = process.env.RABBITMQ_DEFAULT_USER;
  let pass = process.env.RABBITMQ_DEFAULT_PASS;
  if (!user || !pass) {
    const env = readFileSync(resolve(repoRoot, 'infrastructure/docker/.env'), 'utf8');
    for (const line of env.split('\n')) {
      const [key, ...rest] = line.split('=');
      if (key === 'RABBITMQ_DEFAULT_USER') user ??= rest.join('=');
      if (key === 'RABBITMQ_DEFAULT_PASS') pass ??= rest.join('=');
    }
  }
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

const BASE = process.env.RABBITMQ_MGMT_URL ?? 'http://localhost:15672/api';
const V = '%2F';
export const EXCHANGE = 'orders';
export const ROUTING_KEY = 'order.created';
export const MAIN_QUEUE = 'notification.order-created';
export const RETRY_QUEUE = 'notification.order-created.retry';
export const DLQ = 'notification.order-created.dlq';

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    // No keep-alive: a broker restart or the shovel plugin closes idle sockets, and a reused dead socket fails a call.
    headers: { authorization: credentials(), connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok && res.status !== 404) throw new Error(`RabbitMQ management ${method} ${path} -> ${res.status}`);
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

// A well-formed order.created event as order-service publishes it (see EventPublisher / OrdersService.publishCreated).
export function orderCreatedEvent({ eventId = randomUUID(), orderId = randomUUID(), userId = randomUUID(), correlationId = `bt-${randomUUID()}` } = {}) {
  return {
    eventId,
    type: 'order.created',
    occurredAt: new Date().toISOString(),
    correlationId,
    data: { orderId, userId, amount: 10, description: 'broker test' },
  };
}

// Publishes through the real exchange with the same properties the publisher uses. `payload` may be any string.
export async function publish(payload, { routingKey = ROUTING_KEY, messageId = randomUUID(), correlationId = 'bt', headers = {} } = {}) {
  const res = await api('POST', `/exchanges/${V}/${EXCHANGE}/publish`, {
    properties: { delivery_mode: 2, content_type: 'application/json', type: 'order.created', message_id: messageId, correlation_id: correlationId, headers },
    routing_key: routingKey,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    payload_encoding: 'string',
  });
  return res.body.routed;
}

export async function publishEvent(event) {
  const routed = await publish(event, { messageId: event.eventId, correlationId: event.correlationId });
  if (!routed) throw new Error('event was not routed to any queue');
  return event;
}

// Non-destructive read: messages stay in the queue (they are requeued, so `redelivered` is set on them).
export async function peek(queue, count = 500) {
  const res = await api('POST', `/queues/${V}/${queue}/get`, { count, ackmode: 'ack_requeue_true', encoding: 'auto', truncate: 100_000 });
  return res.body;
}

export async function queueInfo(queue) {
  const res = await api('GET', `/queues/${V}/${queue}`);
  return res.status === 404 ? null : res.body;
}

// Removes only the messages that match, leaving everyone else's (other tests', an operator's) where they are.
export async function takeMatching(queue, predicate) {
  const taken = [];
  const drained = await api('POST', `/queues/${V}/${queue}/get`, { count: 1000, ackmode: 'ack_requeue_false', encoding: 'auto', truncate: 100_000 });
  for (const m of drained.body) {
    if (predicate(m)) taken.push(m);
    else {
      await api('POST', `/exchanges/${V}/amq.default/publish`, {
        properties: m.properties,
        routing_key: queue,
        payload: m.payload,
        payload_encoding: m.payload_encoding,
      });
    }
  }
  return taken;
}

export async function createSpyQueue(routingKey = ROUTING_KEY) {
  const name = `test.spy.${randomUUID()}`;
  // x-expires: the broker removes it even if a test dies before cleanup.
  await api('PUT', `/queues/${V}/${name}`, { durable: false, auto_delete: false, arguments: { 'x-expires': 300_000 } });
  await api('POST', `/bindings/${V}/e/${EXCHANGE}/q/${name}`, { routing_key: routingKey });
  return name;
}

export async function deleteQueue(name) {
  await api('DELETE', `/queues/${V}/${name}`);
}

export const idOf = (message) => message.properties.message_id;
