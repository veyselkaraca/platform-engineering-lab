import { ConflictException, Logger, UnprocessableEntityException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { EventPublisher } from '../src/infra/event-publisher.service';
import { IdempotencyKey } from '../src/orders/idempotency-key.entity';
import { Order } from '../src/orders/order.entity';
import { OrdersService } from '../src/orders/orders.service';
import { UserDirectory } from '../src/users/user-directory.service';

const dto = { userId: 'u1', amount: 10.5, description: 'test order' };
const stored = { id: 'o1', ...dto, status: 'CREATED' } as Order;

function setup() {
  const manager = {
    create: jest.fn((_entity, values) => values),
    save: jest.fn(async (values) => ({ ...values, id: 'o1' })),
    insert: jest.fn().mockResolvedValue(undefined),
  };
  const orders = { findOneBy: jest.fn().mockResolvedValue(stored) };
  const keys = { findOneBy: jest.fn().mockResolvedValue(null) };
  const dataSource = { transaction: jest.fn(async (cb) => cb(manager)) };
  const users = { exists: jest.fn().mockResolvedValue(true) };
  const events = { publish: jest.fn().mockResolvedValue(undefined) };
  const service = new OrdersService(
    orders as never,
    keys as never,
    dataSource as never,
    users as unknown as UserDirectory,
    events as unknown as EventPublisher,
  );
  return { service, manager, orders, keys, dataSource, users, events };
}

const uniqueViolation = () => new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate'), { code: '23505' }));

describe('OrdersService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('creates the order and publishes order.created with the correlation id', async () => {
    const { service, events } = setup();
    const result = await service.create(dto, undefined, 'req-1');
    expect(result.created).toBe(true);
    expect(result.order.id).toBe('o1');
    expect(events.publish).toHaveBeenCalledTimes(1);
    const [routingKey, event] = events.publish.mock.calls[0];
    expect(routingKey).toBe('order.created');
    expect(event).toMatchObject({ type: 'order.created', correlationId: 'req-1', data: { orderId: 'o1', userId: 'u1', amount: 10.5 } });
    expect(event.eventId).toEqual(expect.any(String));
  });

  it('rejects an unknown user with 422 and stores/publishes nothing', async () => {
    const { service, users, dataSource, events } = setup();
    users.exists.mockResolvedValue(false);
    await expect(service.create(dto, undefined, 'req-1')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('still returns the order when publishing fails (NFR-4 / ADR-001 limitation)', async () => {
    const { service, events } = setup();
    events.publish.mockRejectedValue(new Error('broker down'));
    await expect(service.create(dto, undefined, 'req-1')).resolves.toMatchObject({ created: true });
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('order.publish_failed orderId=o1'));
  });

  it('stores the idempotency key in the same transaction as the order', async () => {
    const { service, manager } = setup();
    await service.create(dto, 'key-1', 'req-1');
    expect(manager.insert).toHaveBeenCalledWith(IdempotencyKey, { key: 'key-1', orderId: 'o1' });
  });

  it('replays a known idempotency key without a user lookup, insert or publish (FR-9)', async () => {
    const { service, keys, users, dataSource, events } = setup();
    keys.findOneBy.mockResolvedValue({ key: 'key-1', orderId: 'o1' });
    const result = await service.create(dto, 'key-1', 'req-1');
    expect(result).toEqual({ order: stored, created: false });
    expect(users.exists).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('never replays one user\'s order to another user who reuses the key', async () => {
    const { service, keys, users, dataSource } = setup();
    keys.findOneBy.mockResolvedValue({ key: 'key-1', orderId: 'o1' });
    await expect(service.create({ ...dto, userId: 'someone-else' }, 'key-1', 'req-1')).rejects.toBeInstanceOf(ConflictException);
    expect(users.exists).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('forwards the caller authorization to the user lookup', async () => {
    const { service, users } = setup();
    await service.create(dto, undefined, 'req-1', 'Bearer t');
    expect(users.exists).toHaveBeenCalledWith('u1', 'req-1', 'Bearer t');
  });

  it('resolves a concurrent duplicate key to the winning order without publishing', async () => {
    const { service, keys, dataSource, events } = setup();
    keys.findOneBy.mockResolvedValueOnce(null).mockResolvedValueOnce({ key: 'key-1', orderId: 'o1' });
    dataSource.transaction.mockRejectedValue(uniqueViolation());
    await expect(service.create(dto, 'key-1', 'req-1')).resolves.toEqual({ order: stored, created: false });
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('does not swallow unexpected database errors', async () => {
    const { service, dataSource } = setup();
    dataSource.transaction.mockRejectedValue(new Error('connection lost'));
    await expect(service.create(dto, 'key-1', 'req-1')).rejects.toThrow('connection lost');
  });
});
