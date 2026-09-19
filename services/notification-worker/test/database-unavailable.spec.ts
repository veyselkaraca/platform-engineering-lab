// The metrics helper must be imported first: instruments created before a MeterProvider exists stay no-ops.
import { metricValue } from './support/metrics';
import { Controller, Get, INestApplication, Logger, NotFoundException, Query } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { QueryFailedError } from 'typeorm';
import { DatabaseUnavailableFilter, isDatabaseUnavailable } from '../src/common/database-unavailable.filter';

const withCode = (code: string, message = 'boom') => Object.assign(new Error(message), { code });

describe('isDatabaseUnavailable', () => {
  it.each([
    ['DNS failure', withCode('ENOTFOUND', 'getaddrinfo ENOTFOUND postgres')],
    ['refused connection', withCode('ECONNREFUSED')],
    ['reset connection', withCode('ECONNRESET')],
    ['server shutting down', withCode('57P01')],
    ['connection exception class', withCode('08006')],
    ['too many connections', withCode('53300')],
    ['pool connect timeout', new Error('timeout exceeded when trying to connect')],
    ['terminated connection', new Error('Connection terminated unexpectedly')],
    ['driver error wrapped by TypeORM', new QueryFailedError('SELECT 1', [], withCode('57P01'))],
    ['error with a cause', Object.assign(new Error('outer'), { cause: withCode('ECONNREFUSED') })],
  ])('recognises %s', (_name, err) => expect(isDatabaseUnavailable(err)).toBe(true));

  it.each([
    ['unique violation', new QueryFailedError('INSERT', [], withCode('23505'))],
    ['syntax error', new QueryFailedError('SELEC', [], withCode('42601'))],
    ['plain error', new Error('boom')],
    ['nothing', undefined],
    ['a string', 'ECONNREFUSED'],
  ])('does not mistake %s for an outage', (_name, err) => expect(isDatabaseUnavailable(err)).toBe(false));
});

@Controller('probe')
class ProbeController {
  @Get()
  fail(@Query('kind') kind: string) {
    if (kind === 'outage') throw withCode('ENOTFOUND', 'getaddrinfo ENOTFOUND postgres');
    if (kind === 'http') throw new NotFoundException('nope');
    throw new Error('a real bug with secret details');
  }
}

describe('DatabaseUnavailableFilter', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: DatabaseUnavailableFilter }],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers a database outage with a generic 503 and logs the cause with the request id', async () => {
    const res = await request(app.getHttpServer()).get('/probe?kind=outage').set('x-request-id', 'req-77').expect(503);
    expect(res.body).toEqual({ statusCode: 503, message: 'Service temporarily unavailable', error: 'Service Unavailable' });
    expect(JSON.stringify(res.body)).not.toMatch(/postgres|ENOTFOUND/);
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringMatching(/^database\.unavailable requestId=req-77 cause=getaddrinfo ENOTFOUND postgres$/));
  });

  it('counts the responses it turned into 503, and nothing else', async () => {
    const before = await metricValue('database.unavailable.responses');
    await request(app.getHttpServer()).get('/probe?kind=outage').expect(503);
    await request(app.getHttpServer()).get('/probe?kind=http').expect(404);
    await request(app.getHttpServer()).get('/probe?kind=bug').expect(500);
    expect(await metricValue('database.unavailable.responses')).toBe(before + 1);
  });

  it('leaves HTTP exceptions alone', async () => {
    await request(app.getHttpServer()).get('/probe?kind=http').expect(404);
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('keeps every other failure a 500 without leaking its message', async () => {
    const res = await request(app.getHttpServer()).get('/probe?kind=bug').expect(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
