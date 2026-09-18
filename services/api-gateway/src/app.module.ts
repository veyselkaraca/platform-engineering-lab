import { randomUUID } from 'node:crypto';
import { Logger, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { remoteKeys, TokenVerifier } from './auth/token-verifier';
import { Env, validateEnv } from './config/env';
import { createGateway } from './gateway/gateway';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          genReqId: (req, res) => {
            const incoming = req.headers['x-request-id'];
            const id = typeof incoming === 'string' && incoming !== '' ? incoming : randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
        },
      }),
    }),
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  private readonly log = new Logger('Gateway');

  constructor(private readonly config: ConfigService<Env, true>) {}

  configure(consumer: MiddlewareConsumer): void {
    const gateway = createGateway({
      routes: {
        '/v1/users': this.config.get('USER_SERVICE_URL'),
        '/v1/orders': this.config.get('ORDER_SERVICE_URL'),
        '/v1/notifications': this.config.get('NOTIFICATION_WORKER_URL'),
      },
      upstreamTimeoutMs: this.config.get('UPSTREAM_TIMEOUT_MS'),
      rateLimitPerMinute: this.config.get('RATE_LIMIT_PER_MINUTE'),
      verifier: new TokenVerifier(
        remoteKeys(
          this.config.get('AUTH_JWKS_URL'),
          this.config.get('AUTH_JWKS_TIMEOUT_MS'),
          this.config.get('AUTH_JWKS_CACHE_SECONDS'),
        ),
        {
          issuer: this.config.get('AUTH_ISSUER'),
          audience: this.config.get('AUTH_AUDIENCE'),
          clockToleranceSeconds: this.config.get('AUTH_CLOCK_TOLERANCE_SECONDS'),
        },
      ),
      logError: (message) => this.log.error(message),
      logWarn: (message) => this.log.warn(message),
    });
    consumer.apply(...gateway).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
