import { ArgumentsHost, Catch, HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { recordDatabaseUnavailable } from './database.metrics';

// Errors that mean "cannot reach the database" (DNS, refused or reset connection, timeout, server shutting down,
// too many connections, connection exceptions), as opposed to a query that is wrong or violates a constraint.
const CONNECTION_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '53300']);
const CONNECTION_MESSAGE = /connection terminated|timeout exceeded when trying to connect|client has encountered a connection error|connection is closed/i;

export function isDatabaseUnavailable(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 3; depth++) {
    const e = current as { code?: unknown; message?: unknown; driverError?: unknown; cause?: unknown };
    if (typeof e.code === 'string' && (CONNECTION_CODES.has(e.code) || e.code.startsWith('08'))) return true;
    if (typeof e.message === 'string' && CONNECTION_MESSAGE.test(e.message)) return true;
    current = e.driverError ?? e.cause; // TypeORM wraps the driver error
  }
  return false;
}

// A database outage is a temporary condition of a dependency, not a bug in this service: answer 503 with a generic
// body (no host names, no SQL) and log the cause with the request id. Everything else keeps Nest's default handling.
@Catch()
export class DatabaseUnavailableFilter extends BaseExceptionFilter {
  private readonly log = new Logger('database');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof HttpException) && isDatabaseUnavailable(exception)) {
      const req = host.switchToHttp().getRequest<{ id?: string | number; headers: Record<string, unknown> }>();
      const requestId = String(req.id ?? req.headers['x-request-id'] ?? 'unknown');
      recordDatabaseUnavailable();
      this.log.error(`database.unavailable requestId=${requestId} cause=${(exception as Error).message}`);
      return super.catch(new ServiceUnavailableException('Service temporarily unavailable'), host);
    }
    super.catch(exception, host);
  }
}
