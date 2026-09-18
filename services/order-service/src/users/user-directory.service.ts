import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { CacheService } from '../infra/cache.service';

const ATTEMPTS = 2; // one retry, GET only (safe to repeat)

// Answers "does this user exist?" via Redis, falling back to user-service (the source of truth).
@Injectable()
export class UserDirectory {
  private readonly log = new Logger(UserDirectory.name);

  constructor(
    private readonly cache: CacheService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // `authorization` is the caller's own bearer header: user-service authorizes the lookup for the caller
  // (self or admin), so no service-to-service credential is needed. It is forwarded, never logged or cached.
  async exists(userId: string, requestId: string, authorization?: string): Promise<boolean> {
    const key = `user:${userId}`;
    if (await this.cache.get(key)) return true;
    const found = await this.fetchExists(userId, requestId, authorization);
    // Only positive answers are cached: a user created a moment later must not stay "missing" for the TTL.
    if (found) await this.cache.set(key, '1', this.config.get('USER_CACHE_TTL_SECONDS'));
    return found;
  }

  private async fetchExists(userId: string, requestId: string, authorization?: string): Promise<boolean> {
    const url = `${this.config.get('USER_SERVICE_URL')}/v1/users/${userId}`;
    const timeoutMs = this.config.get('USER_LOOKUP_TIMEOUT_MS');
    const headers: Record<string, string> = { 'x-request-id': requestId };
    if (authorization) headers.authorization = authorization;
    let cause = 'unknown';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        void res.body?.cancel(); // release the connection; the body is not needed
        if (res.status === 200) return true;
        if (res.status === 404) return false;
        cause = `user-service responded ${res.status}`;
        if (res.status < 500) break; // unexpected 4xx: retrying will not help
      } catch (err) {
        cause = (err as Error).message;
      }
    }
    this.log.error(`user lookup failed requestId=${requestId} cause=${cause}`);
    throw new ServiceUnavailableException('User lookup is temporarily unavailable');
  }
}
