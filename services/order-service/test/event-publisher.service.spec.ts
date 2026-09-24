import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventPublisher } from '../src/infra/event-publisher.service';

const channel = { on: jest.fn(), publish: jest.fn(), close: jest.fn().mockResolvedValue(undefined) };
const conn = { on: jest.fn(), createConfirmChannel: jest.fn().mockResolvedValue(channel), close: jest.fn().mockResolvedValue(undefined) };
const connect = jest.fn();
jest.mock('amqplib', () => ({ connect: (...args: unknown[]) => connect(...args) }));

const publisher = () => new EventPublisher({ get: () => 'amqp://x' } as unknown as ConfigService<never, true>);
const event = () => ({ eventId: '1', type: 'order.created', occurredAt: new Date().toISOString(), correlationId: 'c1', data: {} });

describe('EventPublisher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('publishes once connected', async () => {
    connect.mockResolvedValue(conn);
    channel.publish.mockImplementation((_ex, _key, _buf, _opts, cb) => cb());

    await expect(publisher().publish('order.created', event())).resolves.toBeUndefined();
  });

  // #72: a DNS lookup stuck on EAI_AGAIN right after the broker container restarts left connect() unsettled for
  // 90+ seconds in CI, because amqplib's own `timeout` option does not bound the lookup. connect() never resolving
  // reproduces that: the publish must still fail close to CONNECT_TIMEOUT_MS, not hang.
  it('bounds a connect() that never settles instead of hanging on a stuck DNS lookup', async () => {
    connect.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();

    await expect(publisher().publish('order.created', event())).rejects.toThrow('connect ETIMEDOUT (outer bound)');

    expect(Date.now() - started).toBeLessThan(2500);
  }, 10_000);

  it('closes a connection that arrives late, after the outer bound already gave up', async () => {
    let resolveLate!: (c: typeof conn) => void;
    connect.mockImplementation(() => new Promise((resolve) => { resolveLate = resolve; }));

    await expect(publisher().publish('order.created', event())).rejects.toThrow();
    resolveLate(conn);
    await new Promise(setImmediate); // let the orphaned attempt's cleanup .then() run

    expect(conn.close).toHaveBeenCalled();
  }, 10_000);
});
