import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationsService } from '../src/notifications/notifications.service';

const ID = '3f6c1c2e-8a3b-4f0e-9d55-0c1d2e3f4a5b';
const event = { eventId: ID, correlationId: 'req-1', orderId: ID, userId: ID };

function setup(rows: unknown[]) {
  const dataSource = { query: jest.fn().mockResolvedValue(rows) };
  return { service: new NotificationsService(dataSource as unknown as DataSource), dataSource };
}

describe('NotificationsService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('stores a notification for a new event, keyed on the event id', async () => {
    const { service, dataSource } = setup([{ id: 'n1' }]);
    await expect(service.record(event)).resolves.toBe(true);
    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (event_id) DO NOTHING');
    expect(params).toEqual([ID, ID, ID]);
    expect(Logger.prototype.log).toHaveBeenCalledWith(expect.stringContaining('notification.sent'));
  });

  it('reports a redelivered event as a duplicate (FR-7)', async () => {
    const { service } = setup([]);
    await expect(service.record(event)).resolves.toBe(false);
    expect(Logger.prototype.log).toHaveBeenCalledWith(expect.stringContaining('notification.duplicate_ignored'));
  });

  it('propagates database errors so the message is retried', async () => {
    const { service, dataSource } = setup([]);
    dataSource.query.mockRejectedValue(new Error('connection lost'));
    await expect(service.record(event)).rejects.toThrow('connection lost');
  });
});
