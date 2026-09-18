export interface AuthEnv {
  AUTH_ISSUER: string;
  AUTH_AUDIENCE: string;
  AUTH_JWKS_URL: string;
  AUTH_JWKS_TIMEOUT_MS: number;
  AUTH_JWKS_CACHE_SECONDS: number;
  AUTH_CLOCK_TOLERANCE_SECONDS: number;
}

function required(raw: Record<string, unknown>, name: string): string {
  const v = raw[name];
  if (typeof v !== 'string' || v === '') throw new Error(`${name} is required`);
  return v;
}

function intBetween(raw: Record<string, unknown>, name: string, fallback: number, max: number): number {
  const n = Number(raw[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
  return n;
}

// Fail at startup on missing/invalid auth config: a service must never become ready unable to verify tokens
// because of configuration (IDN-5). No secrets here: verification uses the identity provider's public keys.
export function validateAuthEnv(raw: Record<string, unknown>): AuthEnv {
  const jwksUrl = required(raw, 'AUTH_JWKS_URL');
  try {
    new URL(jwksUrl);
  } catch {
    throw new Error('AUTH_JWKS_URL must be a valid URL');
  }
  return {
    AUTH_ISSUER: required(raw, 'AUTH_ISSUER'),
    AUTH_AUDIENCE: required(raw, 'AUTH_AUDIENCE'),
    AUTH_JWKS_URL: jwksUrl,
    AUTH_JWKS_TIMEOUT_MS: intBetween(raw, 'AUTH_JWKS_TIMEOUT_MS', 2000, 30_000),
    AUTH_JWKS_CACHE_SECONDS: intBetween(raw, 'AUTH_JWKS_CACHE_SECONDS', 3600, 86_400),
    AUTH_CLOCK_TOLERANCE_SECONDS: intBetween(raw, 'AUTH_CLOCK_TOLERANCE_SECONDS', 5, 60),
  };
}
