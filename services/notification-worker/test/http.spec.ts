import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { HealthCheckService, HealthIndicatorService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import request from 'supertest';
import { AuthGuard } from '../src/auth/auth.guard';
import { TokenVerifier } from '../src/auth/token-verifier';
import { HealthController } from '../src/health/health.controller';
import { ConsumerService } from '../src/messaging/consumer.service';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { NotificationsService } from '../src/notifications/notifications.service';
import { ADMIN_ID, CUSTOMER_ID, makeKeys, signToken, TestKeys, verifierFor } from './support/tokens';

const ORDER_ID = '3f6c1c2e-8a3b-4f0e-9d55-0c1d2e3f4a5b';

describe('HTTP layer', () => {
  let app: INestApplication;
  let keys: TestKeys;
  let customer: string;
  let admin: string;
  const notifications = { findByOrder: jest.fn() };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    keys = await makeKeys();
    customer = await signToken(keys, { sub: CUSTOMER_ID, roles: ['customer'] });
    admin = await signToken(keys, { sub: ADMIN_ID, roles: ['admin'] });
    const mod = await Test.createTestingModule({
      controllers: [NotificationsController, HealthController],
      providers: [
        { provide: NotificationsService, useValue: notifications },
        { provide: HealthCheckService, useValue: {} },
        { provide: TypeOrmHealthIndicator, useValue: {} },
        { provide: HealthIndicatorService, useValue: {} },
        { provide: ConsumerService, useValue: {} },
        { provide: TokenVerifier, useValue: verifierFor(keys) },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  beforeEach(() => notifications.findByOrder.mockReset().mockResolvedValue([{ id: 'n1', orderId: ORDER_ID }]));
  afterAll(() => app.close());

  const get = (token?: string, query = `orderId=${ORDER_ID}`) => {
    const req = request(app.getHttpServer()).get(`/v1/notifications?${query}`);
    return token ? req.set(bearer(token)) : req;
  };

  it('liveness needs no token and no dependencies', () => request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' }));

  it('rejects a request without a token with 401', async () => {
    const res = await get().expect(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(notifications.findByOrder).not.toHaveBeenCalled();
  });

  it('rejects a token without any role with 403', async () => {
    await get(await signToken(keys, { roles: null })).expect(403);
    expect(notifications.findByOrder).not.toHaveBeenCalled();
  });

  it('limits a customer to their own notifications', async () => {
    await get(customer).expect(200, [{ id: 'n1', orderId: ORDER_ID }]);
    expect(notifications.findByOrder).toHaveBeenCalledWith(ORDER_ID, CUSTOMER_ID);
  });

  it('lets an admin see every notification for the order', async () => {
    await get(admin).expect(200);
    expect(notifications.findByOrder).toHaveBeenCalledWith(ORDER_ID, undefined);
  });

  it('rejects a missing orderId with 400', () => get(customer, '').expect(400));
  it('rejects a non-UUID orderId with 400', () => get(customer, 'orderId=123').expect(400));
});
