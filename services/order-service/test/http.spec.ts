import { INestApplication, Logger, NotFoundException, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import request from 'supertest';
import { AuthGuard } from '../src/auth/auth.guard';
import { TokenVerifier } from '../src/auth/token-verifier';
import { HealthController } from '../src/health/health.controller';
import { OrdersController } from '../src/orders/orders.controller';
import { OrdersService } from '../src/orders/orders.service';
import { ADMIN_ID, CUSTOMER_ID, makeKeys, OTHER_ID, signToken, TestKeys, verifierFor } from './support/tokens';

const valid = { userId: CUSTOMER_ID, amount: 25, description: 'test order' };
const ORDER_ID = '3f6c1c2e-8a3b-4f0e-9d55-0c1d2e3f4a5b';

describe('HTTP layer', () => {
  let app: INestApplication;
  let keys: TestKeys;
  let customer: string;
  let admin: string;
  let other: string;
  const orders = { create: jest.fn(), findOne: jest.fn() };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    keys = await makeKeys();
    customer = await signToken(keys, { sub: CUSTOMER_ID, roles: ['customer'] });
    other = await signToken(keys, { sub: OTHER_ID, roles: ['customer'] });
    admin = await signToken(keys, { sub: ADMIN_ID, roles: ['admin'] });
    const mod = await Test.createTestingModule({
      controllers: [OrdersController, HealthController],
      providers: [
        { provide: OrdersService, useValue: orders },
        { provide: HealthCheckService, useValue: {} },
        { provide: TypeOrmHealthIndicator, useValue: {} },
        { provide: TokenVerifier, useValue: verifierFor(keys) },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  beforeEach(() => {
    orders.create.mockReset().mockResolvedValue({ order: { id: 'o1', ...valid }, created: true });
    orders.findOne.mockReset().mockResolvedValue({ id: ORDER_ID, ...valid, status: 'CREATED' });
  });
  afterAll(() => app.close());

  const post = (token = customer) => request(app.getHttpServer()).post('/v1/orders').set(bearer(token));
  const get = (id: string, token = customer) => request(app.getHttpServer()).get(`/v1/orders/${id}`).set(bearer(token));

  describe('authentication', () => {
    it('liveness needs no token and no dependencies', () =>
      request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' }));

    it('rejects a request without a token with 401 and does not reach the service', async () => {
      const res = await request(app.getHttpServer()).post('/v1/orders').send(valid).expect(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('rejects a token from another realm', async () => {
      const foreign = await signToken(keys, { iss: 'http://other/realms/x' });
      await post(foreign).send(valid).expect(401);
    });

    it('ignores client-supplied identity headers', () =>
      request(app.getHttpServer()).post('/v1/orders').set({ 'x-user-id': CUSTOMER_ID, 'x-roles': 'customer' }).send(valid).expect(401));

    it('never logs the token or the Authorization header', async () => {
      const spies = (['warn', 'error', 'log'] as const).map((m) => jest.spyOn(Logger.prototype, m).mockImplementation());
      const forged = await signToken(await makeKeys('evil'));
      await post(forged).send(valid).expect(401);
      await post(customer).send({ ...valid, userId: OTHER_ID }).expect(403);
      const logged = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join('\n');
      spies.forEach((s) => s.mockRestore());
      expect(logged).toContain('auth.rejected');
      expect(logged).toContain('auth.forbidden');
      expect(logged).not.toContain(forged.slice(0, 20));
      expect(logged).not.toContain(customer.slice(0, 20));
      expect(logged.toLowerCase()).not.toContain('bearer');
    });
  });

  describe('POST /v1/orders', () => {
    it('lets a customer order for themself (201)', () => post().send(valid).expect(201));

    it('forbids a customer ordering for another user, without reaching the service', async () => {
      await post().send({ ...valid, userId: OTHER_ID }).expect(403);
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('lets an admin order for any user', () => post(admin).send({ ...valid, userId: OTHER_ID }).expect(201));

    it('rejects a token without any role with 403', async () => {
      await post(await signToken(keys, { roles: null })).send(valid).expect(403);
    });

    it('forwards the caller authorization header to the service (for the user lookup)', async () => {
      await post().send(valid).expect(201);
      expect(orders.create).toHaveBeenCalledWith(expect.objectContaining(valid), undefined, expect.any(String), `Bearer ${customer}`);
    });

    it('answers 200 when the idempotency key replays an existing order', async () => {
      orders.create.mockResolvedValue({ order: { id: 'o1', ...valid }, created: false });
      await post().set('Idempotency-Key', 'k1').send(valid).expect(200);
      expect(orders.create).toHaveBeenCalledWith(expect.objectContaining(valid), 'k1', expect.any(String), `Bearer ${customer}`);
    });

    it.each([
      ['negative amount', { ...valid, amount: -1 }],
      ['zero amount', { ...valid, amount: 0 }],
      ['three decimals', { ...valid, amount: 1.005 }],
      ['string amount', { ...valid, amount: '10' }],
      ['amount over the limit', { ...valid, amount: 2_000_000 }],
      ['non-uuid userId', { ...valid, userId: '123' }],
      ['missing description', { userId: valid.userId, amount: 1 }],
      ['unknown field', { ...valid, status: 'PAID' }],
    ])('rejects %s with 400', async (_name, body) => {
      await post().send(body).expect(400);
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('rejects an empty Idempotency-Key with 400', () => post().set('Idempotency-Key', '').send(valid).expect(400));

    it('rejects an over-long Idempotency-Key with 400', () => post().set('Idempotency-Key', 'k'.repeat(201)).send(valid).expect(400));
  });

  describe('GET /v1/orders/{id}', () => {
    it('lets the owner read the order', () => get(ORDER_ID).expect(200));
    it('lets an admin read any order', () => get(ORDER_ID, admin).expect(200));

    it('answers a non-owner exactly like an unknown order (404, no disclosure)', async () => {
      const notOwner = await get(ORDER_ID, other).expect(404);
      orders.findOne.mockRejectedValue(new NotFoundException('Order not found'));
      const missing = await get(ORDER_ID, other).expect(404);
      expect(notOwner.body).toEqual(missing.body);
    });

    it('needs a token', () => request(app.getHttpServer()).get(`/v1/orders/${ORDER_ID}`).expect(401));
    it('rejects a non-UUID order id with 400', () => get('123').expect(400));
  });
});
