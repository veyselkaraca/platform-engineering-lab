// The metrics helper must be imported first: instruments created before a MeterProvider exists stay no-ops.
import { metricValue } from './support/metrics';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import request from 'supertest';
import { AuthGuard } from '../src/auth/auth.guard';
import { TokenVerifier } from '../src/auth/token-verifier';
import { HealthController } from '../src/health/health.controller';
import { UsersController } from '../src/users/users.controller';
import { UsersService } from '../src/users/users.service';
import { ADMIN_ID, CUSTOMER_ID, makeKeys, OTHER_ID, signToken, TestKeys, verifierFor } from './support/tokens';

describe('HTTP layer', () => {
  let app: INestApplication;
  let keys: TestKeys;
  let customer: string;
  let admin: string;
  const users = { create: jest.fn(async (dto) => ({ ...dto })), findOne: jest.fn(async (id: string) => ({ id })) };
  const newUser = { id: CUSTOMER_ID, email: 'a@b.co', name: 'A' };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    keys = await makeKeys();
    customer = await signToken(keys, { sub: CUSTOMER_ID, roles: ['customer'] });
    admin = await signToken(keys, { sub: ADMIN_ID, roles: ['admin'] });
    const mod = await Test.createTestingModule({
      controllers: [UsersController, HealthController],
      providers: [
        { provide: UsersService, useValue: users },
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

  beforeEach(() => jest.clearAllMocks());
  afterAll(() => app.close());

  const http = () => request(app.getHttpServer());

  describe('authentication', () => {
    it('liveness needs no token and no dependencies', () => http().get('/health/live').expect(200, { status: 'ok' }));

    it('rejects a request without a token with 401 and a generic body', async () => {
      const res = await http().post('/v1/users').send(newUser).expect(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body.message).toBe('Invalid or missing token');
    });

    it('gives the same 401 body whatever the reason', async () => {
      const expired = await signToken(keys, { exp: Math.floor(Date.now() / 1000) - 3600 });
      const a = await http().get(`/v1/users/${CUSTOMER_ID}`).set(bearer(expired)).expect(401);
      const b = await http().get(`/v1/users/${CUSTOMER_ID}`).set({ authorization: 'Basic abc' }).expect(401);
      expect(a.body).toEqual(b.body);
    });

    it('ignores client-supplied identity headers', () =>
      http().post('/v1/users').set({ 'x-user-id': ADMIN_ID, 'x-roles': 'admin' }).send(newUser).expect(401));

    it('answers 503 (never 200) when the keys cannot be obtained', async () => {
      const broken = new TokenVerifier(() => Promise.reject(new Error('boom')), { issuer: 'x', audience: 'y', clockToleranceSeconds: 5 });
      const mod = await Test.createTestingModule({
        controllers: [UsersController],
        providers: [
          { provide: UsersService, useValue: users },
          { provide: TokenVerifier, useValue: broken },
          { provide: APP_GUARD, useClass: AuthGuard },
        ],
      }).compile();
      const a = mod.createNestApplication();
      await a.init();
      const before = await metricValue('auth.rejections', { reason: 'keys_unavailable' });
      await request(a.getHttpServer()).get(`/v1/users/${CUSTOMER_ID}`).set(bearer(customer)).expect(503);
      expect(await metricValue('auth.rejections', { reason: 'keys_unavailable' })).toBe(before + 1);
      await a.close();
    });

    it('never logs the token or the Authorization header', async () => {
      const spies = (['warn', 'error', 'log'] as const).map((m) => jest.spyOn(Logger.prototype, m).mockImplementation());
      const forged = await signToken(await makeKeys('evil'));
      await http().get(`/v1/users/${CUSTOMER_ID}`).set(bearer(forged)).expect(401);
      await http().post('/v1/users').set(bearer(customer)).send(newUser).expect(403);
      await http().get(`/v1/users/${ADMIN_ID}`).set(bearer(customer)).expect(403);
      const logged = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join('\n');
      spies.forEach((s) => s.mockRestore());
      expect(logged).toContain('auth.rejected');
      expect(logged).toContain('auth.forbidden');
      expect(logged).toMatch(/reason=signature/);
      expect(logged).not.toContain(forged.slice(0, 20));
      expect(logged).not.toContain(customer.slice(0, 20));
      expect(logged.toLowerCase()).not.toContain('bearer');
    });
  });

  describe('metrics (IDN-7)', () => {
    const rejected = (reason: string) => metricValue('auth.rejections', { reason });

    it('counts refusals by reason, without user ids or routes as labels', async () => {
      const before = { missing: await rejected('missing'), role: await rejected('role'), notOwner: await rejected('not_owner'), signature: await rejected('signature') };
      await http().get(`/v1/users/${CUSTOMER_ID}`).expect(401);
      await http().post('/v1/users').set(bearer(customer)).send(newUser).expect(403);
      await http().get(`/v1/users/${ADMIN_ID}`).set(bearer(customer)).expect(403);
      await http().get(`/v1/users/${CUSTOMER_ID}`).set(bearer(await signToken(await makeKeys('evil')))).expect(401);
      expect(await rejected('missing')).toBe(before.missing + 1);
      expect(await rejected('role')).toBe(before.role + 1);
      expect(await rejected('not_owner')).toBe(before.notOwner + 1);
      expect(await rejected('signature')).toBe(before.signature + 1);
    });

    it('does not count accepted requests', async () => {
      const before = await metricValue('auth.rejections');
      await http().get(`/v1/users/${CUSTOMER_ID}`).set(bearer(customer)).expect(200);
      expect(await metricValue('auth.rejections')).toBe(before);
    });
  });

  describe('POST /v1/users', () => {
    it('is admin only', async () => {
      await http().post('/v1/users').set(bearer(customer)).send(newUser).expect(403);
      await http().post('/v1/users').set(bearer(admin)).send(newUser).expect(201);
      expect(users.create).toHaveBeenCalledTimes(1);
    });

    it('rejects a token without any role with 403', async () => {
      const bare = await signToken(keys, { roles: null });
      await http().post('/v1/users').set(bearer(bare)).send(newUser).expect(403);
    });

    it('rejects an invalid email with 400', () =>
      http().post('/v1/users').set(bearer(admin)).send({ ...newUser, email: 'nope' }).expect(400));

    it('rejects a missing or non-UUID id with 400', async () => {
      await http().post('/v1/users').set(bearer(admin)).send({ email: 'a@b.co', name: 'A' }).expect(400);
      await http().post('/v1/users').set(bearer(admin)).send({ ...newUser, id: 'alice' }).expect(400);
    });

    it('rejects unknown fields with 400', () =>
      http().post('/v1/users').set(bearer(admin)).send({ ...newUser, admin: true }).expect(400));
  });

  describe('GET /v1/users/{id}', () => {
    it('lets a customer read themself', () => http().get(`/v1/users/${CUSTOMER_ID}`).set(bearer(customer)).expect(200));

    it('forbids a customer reading someone else, without touching the store', async () => {
      await http().get(`/v1/users/${OTHER_ID}`).set(bearer(customer)).expect(403);
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('lets an admin read anyone', () => http().get(`/v1/users/${OTHER_ID}`).set(bearer(admin)).expect(200));
    it('rejects a non-UUID id with 400', () => http().get('/v1/users/123').set(bearer(admin)).expect(400));
  });
});
