import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import request from 'supertest';
import { HealthController } from '../src/health/health.controller';
import { UsersController } from '../src/users/users.controller';
import { UsersService } from '../src/users/users.service';

describe('HTTP layer', () => {
  let app: INestApplication;
  const users = { create: jest.fn(async (dto) => ({ id: 'id-1', ...dto })), findOne: jest.fn() };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [UsersController, HealthController],
      providers: [
        { provide: UsersService, useValue: users },
        { provide: HealthCheckService, useValue: {} },
        { provide: TypeOrmHealthIndicator, useValue: {} },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(() => app.close());

  it('liveness needs no dependencies', () => request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' }));

  it('rejects an invalid email with 400', () =>
    request(app.getHttpServer()).post('/v1/users').send({ email: 'nope', name: 'A' }).expect(400));

  it('rejects unknown fields with 400', () =>
    request(app.getHttpServer()).post('/v1/users').send({ email: 'a@b.co', name: 'A', admin: true }).expect(400));

  it('creates a user with 201', () =>
    request(app.getHttpServer()).post('/v1/users').send({ email: 'a@b.co', name: 'A' }).expect(201));

  it('rejects a non-UUID id with 400', () => request(app.getHttpServer()).get('/v1/users/123').expect(400));
});
