import './telemetry'; // must stay first: instruments modules as they load
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
  // SIGTERM/SIGINT: stop accepting connections, drain, close DB (NFR-6). useProcessExit: true is required
  // because the container runs `node dist/main.js` directly as PID 1 (no init wrapper) -- the default behavior
  // (re-sending the signal via process.kill and relying on its default disposition) is silently a no-op for an
  // unhandled signal on PID 1, so without this the process just sits there until Docker's SIGKILL.
  app.enableShutdownHooks(undefined, { useProcessExit: true });
  await app.listen(app.get(ConfigService<Env, true>).get('PORT'), '0.0.0.0');
}

void bootstrap();
