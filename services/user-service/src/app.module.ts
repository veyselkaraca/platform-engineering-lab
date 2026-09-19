import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { DatabaseUnavailableFilter } from './common/database-unavailable.filter';
import { Env, validateEnv } from './config/env';
import { HealthController } from './health/health.controller';
import { CreateUsers1700000000000 } from './migrations/1700000000000-create-users';
import { User } from './users/user.entity';
import { TelemetryLifecycle } from './telemetry.lifecycle';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          // Correlation: reuse the caller's x-request-id, else create one, and echo it back.
          genReqId: (req, res) => {
            const incoming = req.headers['x-request-id'];
            const id = typeof incoming === 'string' && incoming !== '' ? incoming : randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          // Never log credentials.
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          // Probe traffic would drown real logs.
          autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
        },
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL'),
        entities: [User],
        migrations: [CreateUsers1700000000000],
        migrationsRun: true,
        // A database that does not answer must fail the request, not hang it (AGENTS.md section 17).
        connectTimeoutMS: 2000,
        // Retry so a DB that starts a moment later doesn't crash-loop the container.
        retryAttempts: 5,
        retryDelay: 2000,
      }),
    }),
    TerminusModule,
    AuthModule,
    UsersModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: DatabaseUnavailableFilter }, TelemetryLifecycle],
})
export class AppModule {}
