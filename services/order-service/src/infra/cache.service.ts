import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Env } from '../config/env';
import { cacheOperations } from '../orders/orders.metrics';

// Cache only, never authoritative (engineering standards: Redis). Every failure degrades to a cache miss (NFR-4).
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly log = new Logger(CacheService.name);
  private readonly redis: Redis;
  private healthy = true;

  constructor(config: ConfigService<Env, true>) {
    this.redis = new Redis(config.get('REDIS_URL'), {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false, // fail fast while disconnected instead of queueing requests
      commandTimeout: 500,
      // Explicit rather than ioredis's ~10s default (#72): a DNS lookup stuck on EAI_AGAIN right after the
      // container restarts can otherwise leave a (re)connect attempt unsettled far longer than commandTimeout,
      // which only bounds a command on an already-open connection.
      connectTimeout: 2000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    });
    // Log state changes only, so a Redis outage is one line rather than one per reconnect attempt.
    this.redis.on('error', (err) => {
      if (this.healthy) this.log.warn(`Redis unavailable, falling back to source of truth: ${err.message}`);
      this.healthy = false;
    });
    this.redis.on('ready', () => {
      if (!this.healthy) this.log.log('Redis connection restored');
      this.healthy = true;
    });
  }

  async get(key: string): Promise<string | null> {
    try {
      const value = await this.redis.get(key);
      cacheOperations.add(1, { operation: 'get', outcome: value === null ? 'miss' : 'hit' });
      return value;
    } catch (err) {
      cacheOperations.add(1, { operation: 'get', outcome: 'error' });
      this.log.debug(`cache get failed for ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
      cacheOperations.add(1, { operation: 'set', outcome: 'ok' });
    } catch (err) {
      cacheOperations.add(1, { operation: 'set', outcome: 'error' });
      this.log.debug(`cache set failed for ${key}: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch (err) {
      this.log.warn(`Redis quit failed, forcing disconnect: ${(err as Error).message}`);
      this.redis.disconnect();
    }
  }
}
