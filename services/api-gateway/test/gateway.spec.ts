import express from 'express';
import request from 'supertest';
import { GatewayConfig, createGateway } from '../src/gateway/gateway';
import { TokenVerifier } from '../src/auth/token-verifier';
import { deadUrl, startUpstream } from './support/upstream';
import { makeKeys, signToken, TestKeys, verifierFor } from './support/tokens';

type Upstream = Awaited<ReturnType<typeof startUpstream>>;

let keys: TestKeys;
let token: string;
// Every request carries a valid token unless a test says otherwise.
const authed = (app: express.Express) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${token}`),
  post: (url: string) => request(app).post(url).set('authorization', `Bearer ${token}`),
});

// Mirrors production wiring: no body parser, gateway middleware, then a 404 fallback.
function appWith(overrides: Partial<GatewayConfig> & Pick<GatewayConfig, 'routes'>) {
  const config: GatewayConfig = {
    upstreamTimeoutMs: 2000,
    rateLimitPerMinute: 1000,
    verifier: verifierFor(keys),
    logError: jest.fn(),
    logWarn: jest.fn(),
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
  beforeAll(async () => {
    keys = await makeKeys();
    token = await signToken(keys);
  });

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

      const res = await authed(app).get('/v1/users/u1?verbose=1').expect(200);

      expect(res.body).toEqual({ id: 'u1' });
      expect(res.headers['x-upstream']).toBe('user');
      expect(users.seen[0]).toMatchObject({ method: 'GET', url: '/v1/users/u1?verbose=1' });
    });

    it('sends each prefix to its own upstream', async () => {
      const users = await start();
      const orders = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url, '/v1/orders': orders.url } });

      await authed(app).get('/v1/orders/o1').expect(200);
      await authed(app).get('/v1/users/u1').expect(200);

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

      const res = await authed(app).post('/v1/orders').set('Idempotency-Key', 'k-1').send(payload).expect(201);

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
      const res = await authed(app).get('/v1/users/x').expect(status);
      expect(res.body.message).toBe('from upstream');
    });

    it('does not route unknown paths or prefix look-alikes', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url } });

      await authed(app).get('/v1/other').expect(404);
      await authed(app).get('/v1/users-admin').expect(404);
      await authed(app).get('/health/live').expect(404); // health is served by the app itself, never proxied

      expect(users.seen).toHaveLength(0);
    });
  });

  describe('authentication', () => {
    it('rejects a request without a token with 401 and never contacts the backend', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url } });

      const res = await request(app).get('/v1/users/u1').expect(401);

      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or missing token' });
      expect(users.seen).toHaveLength(0);
    });

    it('gives the same generic 401 whatever is wrong with the token', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url } });
      const expired = await signToken(keys, { exp: Math.floor(Date.now() / 1000) - 3600 });
      const foreign = await signToken(keys, { iss: 'http://other/realms/x' });
      const stranger = await signToken(await makeKeys('evil'));

      const bodies = await Promise.all(
        [expired, foreign, stranger].map(async (t) => (await request(app).get('/v1/users/u1').set('authorization', `Bearer ${t}`).expect(401)).body),
      );

      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(users.seen).toHaveLength(0);
    });

    it('forwards the Authorization header to the backend unchanged', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url } });

      await authed(app).get('/v1/users/u1').expect(200);

      expect(users.seen[0].headers.authorization).toBe(`Bearer ${token}`);
    });

    it('answers 503, never lets the request through, when the keys cannot be obtained', async () => {
      const users = await start();
      const broken = new TokenVerifier(() => Promise.reject(new Error('boom')), { issuer: 'x', audience: 'y', clockToleranceSeconds: 5 });
      const { app } = appWith({ routes: { '/v1/users': users.url }, verifier: broken });

      await authed(app).get('/v1/users/u1').expect(503);

      expect(users.seen).toHaveLength(0);
    });

    it('leaves health and unknown routes to the app (no token needed, no backend involved)', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url } });

      await request(app).get('/health/live').expect(404); // health is served by the app itself in production
      await request(app).get('/v1/unknown').expect(404);
      expect(users.seen).toHaveLength(0);
    });

    it('throttles before it verifies, so a flood of bad tokens hits the limit', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url }, rateLimitPerMinute: 2 });

      await request(app).get('/v1/users/u1').set('authorization', 'Bearer garbage').expect(401);
      await request(app).get('/v1/users/u1').set('authorization', 'Bearer garbage').expect(401);
      await request(app).get('/v1/users/u1').set('authorization', 'Bearer garbage').expect(429);
    });

    it('logs the rejection reason and never the token', async () => {
      const users = await start();
      const { app, config } = appWith({ routes: { '/v1/users': users.url } });
      const stranger = await signToken(await makeKeys('evil'));

      await request(app).get('/v1/users/u1').set('authorization', `Bearer ${stranger}`).expect(401);
      await request(app).get('/v1/users/u1').expect(401);

      const logged = (config.logWarn as jest.Mock).mock.calls.map((c) => String(c[0])).join(' ');
      expect(logged).toMatch(/auth\.rejected requestId=\S+ reason=signature/);
      expect(logged).toMatch(/reason=missing/);
      expect(logged).not.toContain(stranger.slice(0, 20));
      expect(logged.toLowerCase()).not.toContain('bearer');
    });
  });

  describe('request id', () => {
    it('generates one, forwards it upstream and echoes it to the client', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url } });

      const res = await authed(app).get('/v1/users/u1').expect(200);

      const id = res.headers['x-request-id'];
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(users.seen[0].headers['x-request-id']).toBe(id);
    });

    it('reuses the id supplied by the caller', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url } });

      const res = await authed(app).get('/v1/users/u1').set('x-request-id', 'trace-42').expect(200);

      expect(res.headers['x-request-id']).toBe('trace-42');
      expect(users.seen[0].headers['x-request-id']).toBe('trace-42');
    });
  });

  describe('upstream failures', () => {
    it('answers 502 with a structured body that leaks nothing about the upstream', async () => {
      const url = await deadUrl();
      const { app, config } = appWith({ routes: { '/v1/users': url } });

      const res = await authed(app).get('/v1/users/u1').set('x-request-id', 'trace-502').expect(502);

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

      const res = await authed(app).get('/v1/users/u1').expect(504);

      expect(res.body).toEqual({ statusCode: 504, error: 'Gateway Timeout', message: 'Upstream did not respond in time' });
      expect(config.logError).toHaveBeenCalledWith(expect.stringContaining('timedOut=true'));
    });

    it('keeps serving healthy routes while another upstream is down', async () => {
      const orders = await start();
      const { app } = appWith({ routes: { '/v1/users': await deadUrl(), '/v1/orders': orders.url } });

      await authed(app).get('/v1/users/u1').expect(502);
      await authed(app).get('/v1/orders/o1').expect(200);
    });
  });

  describe('rate limiting', () => {
    it('answers 429 with a structured body once the limit is exceeded', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url }, rateLimitPerMinute: 3 });

      for (let i = 0; i < 3; i++) await authed(app).get('/v1/users/u1').expect(200);
      const res = await authed(app).get('/v1/users/u1').expect(429);

      expect(res.body).toEqual({ statusCode: 429, error: 'Too Many Requests', message: 'Too many requests, retry later' });
      expect(res.headers['ratelimit']).toBeDefined();
      expect(users.seen).toHaveLength(3); // the throttled request never reached the upstream
    });

    it('never throttles health probes', async () => {
      const users = await start();
      const { app } = appWith({ routes: { '/v1/users': users.url }, rateLimitPerMinute: 1 });

      await authed(app).get('/v1/users/u1').expect(200);
      await authed(app).get('/v1/users/u1').expect(429);
      // Health falls through to the app (404 in this bare test app), not to the limiter.
      for (let i = 0; i < 5; i++) await authed(app).get('/health/live').expect(404);
    });
  });
});
