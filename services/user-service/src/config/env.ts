import { AuthEnv, validateAuthEnv } from '../auth/auth.config';

export interface Env extends AuthEnv {
  PORT: number;
  LOG_LEVEL: string;
  DATABASE_URL: string;
}

// Fail at startup on bad config so the service never becomes ready misconfigured.
export function validateEnv(raw: Record<string, unknown>): Env {
  const databaseUrl = raw.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl === '') {
    throw new Error('DATABASE_URL is required');
  }
  const port = Number(raw.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return {
    PORT: port,
    LOG_LEVEL: String(raw.LOG_LEVEL ?? 'info'),
    DATABASE_URL: databaseUrl,
    ...validateAuthEnv(raw),
  };
}
