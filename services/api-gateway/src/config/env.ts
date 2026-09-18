export interface Env {
  PORT: number;
  LOG_LEVEL: string;
  USER_SERVICE_URL: string;
  ORDER_SERVICE_URL: string;
  NOTIFICATION_WORKER_URL: string;
  UPSTREAM_TIMEOUT_MS: number;
  RATE_LIMIT_PER_MINUTE: number;
}

function url(raw: Record<string, unknown>, name: string): string {
  const v = raw[name];
  if (typeof v !== 'string' || v === '') throw new Error(`${name} is required`);
  try {
    new URL(v);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return v.replace(/\/+$/, '');
}

function positiveInt(raw: Record<string, unknown>, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(raw[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
  return n;
}

// Fail at startup on bad config so the gateway never becomes ready misconfigured.
export function validateEnv(raw: Record<string, unknown>): Env {
  return {
    PORT: positiveInt(raw, 'PORT', 3000, 65535),
    LOG_LEVEL: String(raw.LOG_LEVEL ?? 'info'),
    USER_SERVICE_URL: url(raw, 'USER_SERVICE_URL'),
    ORDER_SERVICE_URL: url(raw, 'ORDER_SERVICE_URL'),
    NOTIFICATION_WORKER_URL: url(raw, 'NOTIFICATION_WORKER_URL'),
    // Must exceed the slowest legitimate upstream call (order creation: user lookup + broker publish).
    UPSTREAM_TIMEOUT_MS: positiveInt(raw, 'UPSTREAM_TIMEOUT_MS', 10_000),
    RATE_LIMIT_PER_MINUTE: positiveInt(raw, 'RATE_LIMIT_PER_MINUTE', 120),
  };
}
