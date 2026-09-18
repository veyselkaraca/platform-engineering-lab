import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { Env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  // SIGTERM/SIGINT: stop accepting connections, drain, close DB (NFR-6).
  app.enableShutdownHooks();
  await app.listen(app.get(ConfigService<Env, true>).get('PORT'), '0.0.0.0');
}

void bootstrap();
