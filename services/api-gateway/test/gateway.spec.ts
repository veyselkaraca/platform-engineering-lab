import express from 'express';
import request from 'supertest';
import { GatewayConfig, createGateway } from '../src/gateway/gateway';
import { deadUrl, startUpstream } from './support/upstream';

type Upstream = Awaited<ReturnType<typeof startUpstream>>;

// Mirrors production wiring: no body parser, gateway middleware, then a 404 fallback.
function appWith(overrides: Partial<GatewayConfig> & Pick<GatewayConfig, 'routes'>) {
  const config: GatewayConfig = {
    upstreamTimeoutMs: 2000,
    rateLimitPerMinute: 1000,
    logError: jest.fn(),
    ...overrides,
  };
  const app = express();
  app.use(...createGateway(config));
  app.use((_req, res) => {
    res.status(404).json({ statusCode: 404, error: 'Not Found' });
  });
  return { app, config };
}

describe('gateway', () => {
  const upstreams: Upstream[] = [];
  const start = async (...args: Parameters<typeof startUpstream>) => {
    const u = await startUpstream(...args);
    upstreams.push(u);
    return u;
  };
  afterEach(async () => {
    await Promise.all(upstreams.splice(0).map((u) => u.close()));
  });

  describe('routing', () => {
    it('forwards method, path, query and passes the upstream answer through', async () => {
      const users = await start((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'user' });
        res.end('{"id":"u1"}');
      });
      const { app } = appWith({ routes: { '/v1/users': users.url } });

      const res = await request(app).get('/v1/users/u1?verbose=1').expect(200);

      expect(res.body).toEqual({ id: 'u1' });
      expect(res.headers['x-upstream']).toBe('user');
      expect(users.seen[0]).toMatchObject({ method: 'GET', url: '/v1/users/u1?verbose=1' });
    });

    it('sends each prefix to its own upstream', async () => {
      const users = await start();
      const orders = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url, '/v1/orders': orders.url } });

      await request(app).get('/v1/orders/o1').expect(200);
      await request(app).get('/v1/users/u1').expect(200);

      expect(orders.seen.map((s) => s.url)).toEqual(['/v1/orders/o1']);
      expect(users.seen.map((s) => s.url)).toEqual(['/v1/users/u1']);
    });

    it('forwards request bodies and headers such as Idempotency-Key untouched', async () => {
      const orders = await start((_req, res, body) => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(body);
      });
      const { app } = appWith({ routes: { '/v1/orders': orders.url } });
      const payload = { userId: 'u1', amount: 19.99, description: 'a' };

      const res = await request(app).post('/v1/orders').set('Idempotency-Key', 'k-1').send(payload).expect(201);

      expect(res.body).toEqual(payload);
      expect(orders.seen[0].headers['idempotency-key']).toBe('k-1');
      expect(JSON.parse(orders.seen[0].body)).toEqual(payload);
    });

    it.each([422, 404, 503])('preserves an upstream %i instead of rewriting it', async (status) => {
      const users = await start((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ statusCode: status, message: 'from upstream' }));
      });
      const { app } = appWith({ routes: { '/v1/users': users.url } });
      const res = await request(app).get('/v1/users/x').expect(status);
      expect(res.body.message).toBe('from upstream');
    });

    it('does not route unknown paths or prefix look-alikes', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url } });

      await request(app).get('/v1/other').expect(404);
      await request(app).get('/v1/users-admin').expect(404);
      await request(app).get('/health/live').expect(404); // health is served by the app itself, never proxied

      expect(users.seen).toHaveLength(0);
    });
  });

  describe('request id', () => {
    it('generates one, forwards it upstream and echoes it to the client', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url } });

      const res = await request(app).get('/v1/users/u1').expect(200);

      const id = res.headers['x-request-id'];
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(users.seen[0].headers['x-request-id']).toBe(id);
    });

    it('reuses the id supplied by the caller', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url } });

      const res = await request(app).get('/v1/users/u1').set('x-request-id', 'trace-42').expect(200);

      expect(res.headers['x-request-id']).toBe('trace-42');
      expect(users.seen[0].headers['x-request-id']).toBe('trace-42');
    });
  });

  describe('upstream failures', () => {
    it('answers 502 with a structured body that leaks nothing about the upstream', async () => {
      const url = await deadUrl();
      const { app, config } = appWith({ routes: { '/v1/users': url } });

      const res = await request(app).get('/v1/users/u1').set('x-request-id', 'trace-502').expect(502);

      expect(res.body).toEqual({ statusCode: 502, error: 'Bad Gateway', message: 'Upstream service unavailable' });
      expect(JSON.stringify(res.body)).not.toContain(new URL(url).port);
      expect(config.logError).toHaveBeenCalledWith(expect.stringContaining('requestId=trace-502'));
      expect(config.logError).toHaveBeenCalledWith(expect.stringContaining('timedOut=false'));
    });

    it('answers 504 when the upstream is slower than the timeout', async () => {
      const slow = await start((_req, res) => {
        setTimeout(() => res.end('late'), 1500);
      });
      const { app, config } = appWith({ routes: { '/v1/users': slow.url }, upstreamTimeoutMs: 300 });

      const res = await request(app).get('/v1/users/u1').expect(504);

      expect(res.body).toEqual({ statusCode: 504, error: 'Gateway Timeout', message: 'Upstream did not respond in time' });
      expect(config.logError).toHaveBeenCalledWith(expect.stringContaining('timedOut=true'));
    });

    it('keeps serving healthy routes while another upstream is down', async () => {
      const orders = await start();
      const { app } = appWith({ routes: { '/v1/users': await deadUrl(), '/v1/orders': orders.url } });

      await request(app).get('/v1/users/u1').expect(502);
      await request(app).get('/v1/orders/o1').expect(200);
    });
  });

  describe('rate limiting', () => {
    it('answers 429 with a structured body once the limit is exceeded', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url }, rateLimitPerMinute: 3 });

      for (let i = 0; i < 3; i++) await request(app).get('/v1/users/u1').expect(200);
      const res = await request(app).get('/v1/users/u1').expect(429);

      expect(res.body).toEqual({ statusCode: 429, error: 'Too Many Requests', message: 'Too many requests, retry later' });
      expect(res.headers['ratelimit']).toBeDefined();
      expect(users.seen).toHaveLength(3); // the throttled request never reached the upstream
    });

    it('never throttles health probes', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url }, rateLimitPerMinute: 1 });

      await request(app).get('/v1/users/u1').expect(200);
      await request(app).get('/v1/users/u1').expect(429);
      // Health falls through to the app (404 in this bare test app), not to the limiter.
      for (let i = 0; i < 5; i++) await request(app).get('/health/live').expect(404);
    });
  });
});
