import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthCheckService, HealthIndicatorService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import request from 'supertest';
import { HealthController } from '../src/health/health.controller';
import { ConsumerService } from '../src/messaging/consumer.service';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { NotificationsService } from '../src/notifications/notifications.service';

const ORDER_ID = '3f6c1c2e-8a3b-4f0e-9d55-0c1d2e3f4a5b';

describe('HTTP layer', () => {
  let app: INestApplication;
  const notifications = { findByOrder: jest.fn().mockResolvedValue([{ id: 'n1', orderId: ORDER_ID }]) };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [NotificationsController, HealthController],
      providers: [
        { provide: NotificationsService, useValue: notifications },
        { provide: HealthCheckService, useValue: {} },
        { provide: TypeOrmHealthIndicator, useValue: {} },
        { provide: HealthIndicatorService, useValue: {} },
        { provide: ConsumerService, useValue: {} },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('liveness needs no dependencies', () => request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' }));

  it('returns the notifications recorded for an order', async () => {
    await request(app.getHttpServer()).get(`/v1/notifications?orderId=${ORDER_ID}`).expect(200, [{ id: 'n1', orderId: ORDER_ID }]);
    expect(notifications.findByOrder).toHaveBeenCalledWith(ORDER_ID);
  });

  it('rejects a missing orderId with 400', () => request(app.getHttpServer()).get('/v1/notifications').expect(400));

  it('rejects a non-UUID orderId with 400', () => request(app.getHttpServer()).get('/v1/notifications?orderId=123').expect(400));
});
