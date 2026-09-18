import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { ConsumerService, failedAttempts } from '../src/messaging/consumer.service';
import { DLQ, MAIN_QUEUE } from '../src/messaging/topology';
import { NotificationsService } from '../src/notifications/notifications.service';

const ID = '3f6c1c2e-8a3b-4f0e-9d55-0c1d2e3f4a5b';
const event = { eventId: ID, type: 'order.created', correlationId: 'req-1', data: { orderId: ID, userId: ID } };
const MAX_ATTEMPTS = 3;

function message(body: unknown, headers?: Record<string, unknown>): ConsumeMessage {
  return {
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: {},
    properties: { messageId: ID, correlationId: 'req-1', contentType: 'application/json', headers },
  } as unknown as ConsumeMessage;
}

const death = (queue: string, reason: string, count: number) => ({ queue, reason, count });

function setup(publishError?: Error) {
  const notifications = { record: jest.fn().mockResolvedValue(true) };
  const config = { get: (k: string) => ({ RABBITMQ_URL: 'amqp://x', WORKER_PREFETCH: 10, MAX_ATTEMPTS }[k]) };
  const consumer = new ConsumerService(config as unknown as ConfigService<never, true>, notifications as unknown as NotificationsService);
  const ch = {
    ack: jest.fn(),
    nack: jest.fn(),
    publish: jest.fn((_ex, _key, _content, _opts, cb: (err: Error | null) => void) => cb(publishError ?? null)),
  };
  return { consumer, notifications, ch, channel: ch as unknown as ConfirmChannel };
}

describe('failedAttempts', () => {
  it('is 0 for a first delivery', () => {
    expect(failedAttempts(message(event))).toBe(0);
  });

  it('counts only rejections from the main queue', () => {
    const headers = {
      'x-death': [
        death(`${MAIN_QUEUE}.retry`, 'expired', 5), // the TTL hop is not a failed attempt
        death(MAIN_QUEUE, 'rejected', 2),
      ],
    };
    expect(failedAttempts(message(event, headers))).toBe(2);
  });
});

describe('ConsumerService.handleMessage', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('acks a processed message', async () => {
    const { consumer, ch, channel, notifications } = setup();
    const msg = message(event);
    await consumer.handleMessage(channel, msg);
    expect(notifications.record).toHaveBeenCalledWith({ eventId: ID, correlationId: 'req-1', orderId: ID, userId: ID });
    expect(ch.ack).toHaveBeenCalledWith(msg);
    expect(ch.nack).not.toHaveBeenCalled();
  });

  it('acks a duplicate delivery without treating it as a failure (FR-7)', async () => {
    const { consumer, ch, channel, notifications } = setup();
    notifications.record.mockResolvedValue(false);
    await consumer.handleMessage(channel, message(event));
    expect(ch.ack).toHaveBeenCalledTimes(1);
    expect(ch.nack).not.toHaveBeenCalled();
  });

  it('dead-letters a malformed message immediately, without retrying', async () => {
    const { consumer, ch, channel, notifications } = setup();
    const msg = message('{not json');
    await consumer.handleMessage(channel, msg);
    expect(notifications.record).not.toHaveBeenCalled();
    expect(ch.publish).toHaveBeenCalledTimes(1);
    const [exchange, routingKey, content, options] = ch.publish.mock.calls[0];
    expect(exchange).toBe('');
    expect(routingKey).toBe(DLQ);
    expect(content).toBe(msg.content);
    expect(options.persistent).toBe(true);
    expect(options.headers['x-failure-reason']).toContain('permanent failure');
    expect(ch.ack).toHaveBeenCalledWith(msg);
    expect(ch.nack).not.toHaveBeenCalled();
  });

  it('sends a transient failure to the retry path via nack(requeue=false)', async () => {
    const { consumer, ch, channel, notifications } = setup();
    notifications.record.mockRejectedValue(new Error('database unavailable'));
    const msg = message(event);
    await consumer.handleMessage(channel, msg);
    expect(ch.nack).toHaveBeenCalledWith(msg, false, false);
    expect(ch.publish).not.toHaveBeenCalled();
    expect(ch.ack).not.toHaveBeenCalled();
  });

  it('still retries while below the attempt limit', async () => {
    const { consumer, ch, channel, notifications } = setup();
    notifications.record.mockRejectedValue(new Error('database unavailable'));
    await consumer.handleMessage(channel, message(event, { 'x-death': [death(MAIN_QUEUE, 'rejected', MAX_ATTEMPTS - 2)] }));
    expect(ch.nack).toHaveBeenCalledTimes(1);
    expect(ch.publish).not.toHaveBeenCalled();
  });

  it('dead-letters once the attempt limit is reached and drops the x-death header', async () => {
    const { consumer, ch, channel, notifications } = setup();
    notifications.record.mockRejectedValue(new Error('database unavailable'));
    const msg = message(event, { 'x-death': [death(MAIN_QUEUE, 'rejected', MAX_ATTEMPTS - 1)], 'x-custom': 'kept' });
    await consumer.handleMessage(channel, msg);
    const options = ch.publish.mock.calls[0][3];
    expect(options.headers['x-failure-reason']).toContain(`gave up after ${MAX_ATTEMPTS} attempts`);
    expect(options.headers['x-failed-attempts']).toBe(MAX_ATTEMPTS);
    expect(options.headers['x-custom']).toBe('kept');
    expect(options.headers['x-death']).toBeUndefined();
    expect(ch.ack).toHaveBeenCalledWith(msg);
    expect(ch.nack).not.toHaveBeenCalled();
  });

  it('falls back to the retry path when the DLQ publish fails, instead of losing the message', async () => {
    const { consumer, ch, channel } = setup(new Error('broker refused'));
    const msg = message('{not json');
    await consumer.handleMessage(channel, msg);
    expect(ch.ack).not.toHaveBeenCalled();
    expect(ch.nack).toHaveBeenCalledWith(msg, false, false);
  });
});
