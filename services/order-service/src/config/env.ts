export interface Env {
  PORT: number;
  LOG_LEVEL: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  RABBITMQ_URL: string;
  USER_SERVICE_URL: string;
  USER_LOOKUP_TIMEOUT_MS: number;
  USER_CACHE_TTL_SECONDS: number;
}

function required(raw: Record<string, unknown>, name: string): string {
  const v = raw[name];
  if (typeof v !== 'string' || v === '') throw new Error(`${name} is required`);
  return v;
}

function positiveInt(raw: Record<string, unknown>, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(raw[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
  return n;
}

// Fail at startup on bad config so the service never becomes ready misconfigured.
export function validateEnv(raw: Record<string, unknown>): Env {
  return {
    PORT: positiveInt(raw, 'PORT', 3000, 65535),
    LOG_LEVEL: String(raw.LOG_LEVEL ?? 'info'),
    DATABASE_URL: required(raw, 'DATABASE_URL'),
    REDIS_URL: required(raw, 'REDIS_URL'),
    RABBITMQ_URL: required(raw, 'RABBITMQ_URL'),
    USER_SERVICE_URL: required(raw, 'USER_SERVICE_URL').replace(/\/+$/, ''),
    USER_LOOKUP_TIMEOUT_MS: positiveInt(raw, 'USER_LOOKUP_TIMEOUT_MS', 2000),
    USER_CACHE_TTL_SECONDS: positiveInt(raw, 'USER_CACHE_TTL_SECONDS', 60),
  };
}
