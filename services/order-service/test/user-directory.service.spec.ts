// The metrics helper must be imported first: instruments created before a MeterProvider exists stay no-ops.
import { metricValue } from './support/metrics';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../src/infra/cache.service';
import { UserDirectory } from '../src/users/user-directory.service';

const settings: Record<string, unknown> = {
  USER_SERVICE_URL: 'http://user-service:3000',
  USER_LOOKUP_TIMEOUT_MS: 100,
  USER_CACHE_TTL_SECONDS: 60,
};

function setup(cached: string | null = null) {
  const cache = { get: jest.fn().mockResolvedValue(cached), set: jest.fn().mockResolvedValue(undefined) };
  const config = { get: (k: string) => settings[k] };
  const directory = new UserDirectory(cache as unknown as CacheService, config as unknown as ConfigService<never, true>);
  return { directory, cache };
}

const respond = (status: number) => new Response(null, { status });

describe('UserDirectory', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers from the cache without calling user-service', async () => {
    const { directory } = setup('1');
    await expect(directory.exists('u1', 'req-1')).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to user-service on a miss (also the Redis-down path) and caches a positive answer', async () => {
    fetchMock.mockResolvedValue(respond(200));
    const { directory, cache } = setup();
    await expect(directory.exists('u1', 'req-1')).resolves.toBe(true);
    expect(cache.set).toHaveBeenCalledWith('user:u1', '1', 60);
  });

  it('propagates the request id to user-service', async () => {
    fetchMock.mockResolvedValue(respond(200));
    await setup().directory.exists('u1', 'req-42');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'x-request-id': 'req-42' });
  });

  it('counts lookups by outcome', async () => {
    const outcome = (o: string) => metricValue('user.lookups', { outcome: o });
    const before = { hit: await outcome('cache_hit'), found: await outcome('found'), missing: await outcome('not_found'), down: await outcome('unavailable') };

    await setup('1').directory.exists('u1', 'req-1');
    fetchMock.mockResolvedValueOnce(respond(200));
    await setup().directory.exists('u1', 'req-1');
    fetchMock.mockResolvedValueOnce(respond(404));
    await setup().directory.exists('u2', 'req-1');
    fetchMock.mockResolvedValue(respond(500));
    await expect(setup().directory.exists('u3', 'req-1')).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(await outcome('cache_hit')).toBe(before.hit + 1);
    expect(await outcome('found')).toBe(before.found + 1);
    expect(await outcome('not_found')).toBe(before.missing + 1);
    expect(await outcome('unavailable')).toBe(before.down + 1);
  });

  it('forwards the caller authorization header so user-service can authorize the lookup', async () => {
    fetchMock.mockResolvedValue(respond(200));
    await setup().directory.exists('u1', 'req-42', 'Bearer caller-token');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'x-request-id': 'req-42', authorization: 'Bearer caller-token' });
  });

  it('never logs the forwarded authorization header, even when the lookup fails', async () => {
    fetchMock.mockResolvedValue(respond(500));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await expect(setup().directory.exists('u1', 'req-1', 'Bearer caller-token')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(error.mock.calls.flat().join(' ')).not.toContain('caller-token');
  });

  it('treats a forbidden lookup (403) as a failure, not as "user missing"', async () => {
    fetchMock.mockResolvedValue(respond(403));
    await expect(setup().directory.exists('u1', 'req-1', 'Bearer other')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns false for an unknown user and does not cache it', async () => {
    fetchMock.mockResolvedValue(respond(404));
    const { directory, cache } = setup();
    await expect(directory.exists('u1', 'req-1')).resolves.toBe(false);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('retries once on a 5xx, then answers 503', async () => {
    fetchMock.mockResolvedValue(respond(500));
    await expect(setup().directory.exists('u1', 'req-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers when the retry succeeds after a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(respond(200));
    await expect(setup().directory.exists('u1', 'req-1')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry an unexpected 4xx', async () => {
    fetchMock.mockResolvedValue(respond(400));
    await expect(setup().directory.exists('u1', 'req-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
