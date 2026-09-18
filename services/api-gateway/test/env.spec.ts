import { validateEnv } from '../src/config/env';

const base = {
  USER_SERVICE_URL: 'http://user-service:3000',
  ORDER_SERVICE_URL: 'http://order-service:3000',
  NOTIFICATION_WORKER_URL: 'http://notification-worker:3000',
  AUTH_ISSUER: 'http://idp.test/realms/lab',
  AUTH_AUDIENCE: 'platform-api',
  AUTH_JWKS_URL: 'http://idp.test/realms/lab/protocol/openid-connect/certs',
};

describe('validateEnv (auth)', () => {
  it('applies defaults', () => {
    expect(validateEnv(base)).toMatchObject({ AUTH_JWKS_TIMEOUT_MS: 2000, AUTH_JWKS_CACHE_SECONDS: 3600, AUTH_CLOCK_TOLERANCE_SECONDS: 5 });
  });

  it.each(['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL'])('refuses to start without %s', (name) => {
    expect(() => validateEnv({ ...base, [name]: undefined })).toThrow(`${name} is required`);
    expect(() => validateEnv({ ...base, [name]: '' })).toThrow(`${name} is required`);
  });

  it('rejects a JWKS URL that is not a URL', () => {
    expect(() => validateEnv({ ...base, AUTH_JWKS_URL: 'nope' })).toThrow('AUTH_JWKS_URL must be a valid URL');
  });

  it('bounds the clock tolerance', () => {
    expect(() => validateEnv({ ...base, AUTH_CLOCK_TOLERANCE_SECONDS: 61 })).toThrow('AUTH_CLOCK_TOLERANCE_SECONDS');
    expect(() => validateEnv({ ...base, AUTH_CLOCK_TOLERANCE_SECONDS: 0 })).toThrow('AUTH_CLOCK_TOLERANCE_SECONDS');
  });
});
