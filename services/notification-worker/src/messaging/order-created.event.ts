// A failure that retrying cannot fix (malformed message). Goes straight to the DLQ.
export class PermanentError extends Error {}

export interface OrderCreatedEvent {
  eventId: string;
  correlationId: string;
  orderId: string;
  userId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new PermanentError(`${name} must be a UUID`);
  return value;
}

export function parseOrderCreated(content: Buffer): OrderCreatedEvent {
  let body: unknown;
  try {
    body = JSON.parse(content.toString('utf8'));
  } catch {
    throw new PermanentError('message body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null) throw new PermanentError('message body must be an object');
  const event = body as { eventId?: unknown; type?: unknown; correlationId?: unknown; data?: { orderId?: unknown; userId?: unknown } };
  if (event.type !== 'order.created') throw new PermanentError(`unexpected event type: ${String(event.type)}`);
  return {
    eventId: uuid(event.eventId, 'eventId'),
    correlationId: typeof event.correlationId === 'string' ? event.correlationId : 'unknown',
    orderId: uuid(event.data?.orderId, 'data.orderId'),
    userId: uuid(event.data?.userId, 'data.userId'),
  };
}
