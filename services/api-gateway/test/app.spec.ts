import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { startUpstream } from './support/upstream';

type Upstream = Awaited<ReturnType<typeof startUpstream>>;

// Boots the real AppModule (logger, config validation, Nest middleware wiring) against stub backends.
describe('api-gateway application', () => {
  let app: INestApplication;
  let users: Upstream;
  let orders: Upstream;
  let notifications: Upstream;

  beforeAll(async () => {
    users = await startUpstream();
    orders = await startUpstream((_req, res, body) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(body);
    });
    notifications = await startUpstream();
    Object.assign(process.env, {
      LOG_LEVEL: 'silent',
      USER_SERVICE_URL: users.url,
      ORDER_SERVICE_URL: orders.url,
      NOTIFICATION_WORKER_URL: notifications.url,
    });
    // Imported after the environment is set: ConfigModule validates it when the module is evaluated.
    const { AppModule } = await import('../src/app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>({ bodyParser: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([users.close(), orders.close(), notifications.close()]);
  });

  it('serves its own health endpoints without touching any backend', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
    await request(app.getHttpServer()).get('/health/ready').expect(200, { status: 'ok' });
    expect([...users.seen, ...orders.seen, ...notifications.seen]).toHaveLength(0);
  });

  it('routes the three public prefixes to their backends', async () => {
    await request(app.getHttpServer()).get('/v1/users/u1').expect(200);
    await request(app.getHttpServer()).get('/v1/notifications?orderId=o1').expect(200);
    expect(users.seen.map((s) => s.url)).toEqual(['/v1/users/u1']);
    expect(notifications.seen.map((s) => s.url)).toEqual(['/v1/notifications?orderId=o1']);
  });

  it('forwards POST bodies through Nest untouched and correlates the request', async () => {
    const payload = { userId: 'u1', amount: 5, description: 'x' };

    const res = await request(app.getHttpServer()).post('/v1/orders').set('x-request-id', 'trace-app-1').send(payload).expect(201);

    expect(res.body).toEqual(payload);
    expect(res.headers['x-request-id']).toBe('trace-app-1');
    expect(orders.seen.at(-1)?.headers['x-request-id']).toBe('trace-app-1');
  });

  it('answers 404 for routes it does not own', () => request(app.getHttpServer()).get('/v1/unknown').expect(404));

});
