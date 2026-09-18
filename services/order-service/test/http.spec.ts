import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import request from 'supertest';
import { HealthController } from '../src/health/health.controller';
import { OrdersController } from '../src/orders/orders.controller';
import { OrdersService } from '../src/orders/orders.service';

const valid = { userId: '3f6c1c2e-8a3b-4f0e-9d55-0c1d2e3f4a5b', amount: 25, description: 'test order' };

describe('HTTP layer', () => {
  let app: INestApplication;
  const orders = { create: jest.fn(), findOne: jest.fn() };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [OrdersController, HealthController],
      providers: [
        { provide: OrdersService, useValue: orders },
        { provide: HealthCheckService, useValue: {} },
        { provide: TypeOrmHealthIndicator, useValue: {} },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  beforeEach(() => orders.create.mockReset().mockResolvedValue({ order: { id: 'o1', ...valid }, created: true }));
  afterAll(() => app.close());

  const post = () => request(app.getHttpServer()).post('/v1/orders');

  it('liveness needs no dependencies', () => request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' }));

  it('creates an order with 201', () => post().send(valid).expect(201));

  it('answers 200 when the idempotency key replays an existing order', async () => {
    orders.create.mockResolvedValue({ order: { id: 'o1', ...valid }, created: false });
    await post().set('Idempotency-Key', 'k1').send(valid).expect(200);
    expect(orders.create).toHaveBeenCalledWith(expect.objectContaining(valid), 'k1', expect.any(String));
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

  it('rejects a non-UUID order id with 400', () => request(app.getHttpServer()).get('/v1/orders/123').expect(400));
});
