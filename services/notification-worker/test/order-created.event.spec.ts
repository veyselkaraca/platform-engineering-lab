import { PermanentError, parseOrderCreated } from '../src/messaging/order-created.event';

const ID = '3f6c1c2e-8a3b-4f0e-9d55-0c1d2e3f4a5b';
const valid = {
  eventId: ID,
  type: 'order.created',
  occurredAt: '2026-01-01T00:00:00.000Z',
  correlationId: 'req-1',
  data: { orderId: ID, userId: ID, amount: 10 },
};
const buf = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));

describe('parseOrderCreated', () => {
  it('extracts the fields the worker needs', () => {
    expect(parseOrderCreated(buf(valid))).toEqual({ eventId: ID, correlationId: 'req-1', orderId: ID, userId: ID });
  });

  it('tolerates a missing correlation id', () => {
    expect(parseOrderCreated(buf({ ...valid, correlationId: undefined })).correlationId).toBe('unknown');
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a non-object body', '42'],
    ['null', 'null'],
    ['a different event type', { ...valid, type: 'order.cancelled' }],
    ['a non-UUID eventId', { ...valid, eventId: 'abc' }],
    ['a missing orderId', { ...valid, data: { userId: ID } }],
    ['a missing data section', { ...valid, data: undefined }],
    ['a non-UUID userId', { ...valid, data: { orderId: ID, userId: 5 } }],
  ])('rejects %s as a permanent failure', (_name, body) => {
    expect(() => parseOrderCreated(buf(body))).toThrow(PermanentError);
  });
});
