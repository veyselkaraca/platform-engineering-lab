// The metrics helper must be imported first: instruments created before a MeterProvider exists stay no-ops.
import { metricValue } from './support/metrics';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../src/infra/cache.service';

const redis = { get: jest.fn(), set: jest.fn(), on: jest.fn(), quit: jest.fn(), disconnect: jest.fn() };
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn(() => redis) }));

const cache = () => new CacheService({ get: () => 'redis://x' } as unknown as ConfigService<never, true>);
const ops = (operation: string, outcome: string) => metricValue('cache.operations', { operation, outcome });

describe('CacheService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('counts hits, misses and errors, and turns every failure into a miss (NFR-4)', async () => {
    const before = { hit: await ops('get', 'hit'), miss: await ops('get', 'miss'), error: await ops('get', 'error') };
    const c = cache();
    redis.get.mockResolvedValueOnce('1').mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('down'));

    expect(await c.get('a')).toBe('1');
    expect(await c.get('b')).toBeNull();
    expect(await c.get('c')).toBeNull();

    expect(await ops('get', 'hit')).toBe(before.hit + 1);
    expect(await ops('get', 'miss')).toBe(before.miss + 1);
    expect(await ops('get', 'error')).toBe(before.error + 1);
  });

  it('counts writes and swallows their failures', async () => {
    const before = { ok: await ops('set', 'ok'), error: await ops('set', 'error') };
    const c = cache();
    redis.set.mockResolvedValueOnce('OK').mockRejectedValueOnce(new Error('down'));

    await c.set('a', '1', 60);
    await c.set('b', '1', 60);

    expect(await ops('set', 'ok')).toBe(before.ok + 1);
    expect(await ops('set', 'error')).toBe(before.error + 1);
  });
});
