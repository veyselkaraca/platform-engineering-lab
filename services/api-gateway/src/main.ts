import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { Env } from './config/env';

async function bootstrap() {
  // bodyParser off: the gateway forwards request bodies untouched instead of parsing (and consuming) them.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  // SIGTERM/SIGINT: stop accepting connections and drain in-flight requests.
  app.enableShutdownHooks();
  await app.listen(app.get(ConfigService<Env, true>).get('PORT'), '0.0.0.0');
}

void bootstrap();
