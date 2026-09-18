export interface Env {
  PORT: number;
  LOG_LEVEL: string;
  DATABASE_URL: string;
  RABBITMQ_URL: string;
  WORKER_PREFETCH: number;
  MAX_ATTEMPTS: number;
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

// Fail at startup on bad config so the worker never becomes ready misconfigured.
export function validateEnv(raw: Record<string, unknown>): Env {
  return {
    PORT: positiveInt(raw, 'PORT', 3000, 65535),
    LOG_LEVEL: String(raw.LOG_LEVEL ?? 'info'),
    DATABASE_URL: required(raw, 'DATABASE_URL'),
    RABBITMQ_URL: required(raw, 'RABBITMQ_URL'),
    // Backpressure: at most this many unacknowledged messages in flight (AGENTS.md section 17).
    WORKER_PREFETCH: positiveInt(raw, 'WORKER_PREFETCH', 10, 1000),
    // Total processing attempts before a message is dead-lettered.
    MAX_ATTEMPTS: positiveInt(raw, 'MAX_ATTEMPTS', 3, 100),
  };
}
