import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { TelemetryLifecycle } from './telemetry.lifecycle';
import { DatabaseUnavailableFilter } from './common/database-unavailable.filter';
import { Env, validateEnv } from './config/env';
import { HealthController } from './health/health.controller';
import { ConsumerService } from './messaging/consumer.service';
import { CreateNotifications1700000000000 } from './migrations/1700000000000-create-notifications';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';

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
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL'),
        entities: [],
        migrations: [CreateNotifications1700000000000],
        migrationsRun: true,
        // A database that does not answer must fail the request, not hang it (engineering standards: Reliability).
        connectTimeoutMS: 2000,
        retryAttempts: 5,
        retryDelay: 2000,
      }),
    }),
    TerminusModule,
    AuthModule,
  ],
  controllers: [HealthController, NotificationsController],
  providers: [NotificationsService, ConsumerService, { provide: APP_FILTER, useClass: DatabaseUnavailableFilter }, TelemetryLifecycle],
})
export class AppModule {}
