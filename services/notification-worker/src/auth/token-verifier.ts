import { createRemoteJWKSet, errors, jwtVerify, JWTVerifyGetKey } from 'jose';

export interface Principal {
  sub: string;
  roles: string[];
}

export type RejectReason =
  | 'missing'
  | 'malformed'
  | 'expired'
  | 'not_yet_valid'
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'claims';

// The token is unacceptable: the caller must present a different one (401).
export class TokenInvalid extends Error {
  constructor(readonly reason: RejectReason) {
    super(reason);
  }
}

// The keys needed to judge the token could not be obtained: fail closed (503), never accept.
export class KeysUnavailable extends Error {}

export interface VerifierOptions {
  issuer: string;
  audience: string;
  clockToleranceSeconds: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The key resolver is injected: a remote JWKS (cached, timeout-bound) in production, a local key set in tests.
export class TokenVerifier {
  constructor(
    private readonly getKey: JWTVerifyGetKey,
    private readonly options: VerifierOptions,
  ) {}

  async verify(token: string): Promise<Principal> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.getKey, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        // Asymmetric only: rules out `alg: none` and HMAC-with-the-public-key confusion.
        algorithms: ['RS256'],
        clockTolerance: this.options.clockToleranceSeconds,
        requiredClaims: ['sub', 'exp'],
      }));
    } catch (err) {
      throw classify(err);
    }
    if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) throw new TokenInvalid('claims');
    const access = payload.realm_access as { roles?: unknown } | undefined;
    const roles = Array.isArray(access?.roles) ? access.roles.filter((r): r is string => typeof r === 'string') : [];
    return { sub: payload.sub.toLowerCase(), roles };
  }
}

function classify(err: unknown): Error {
  if (err instanceof errors.JWTExpired) return new TokenInvalid('expired');
  if (err instanceof errors.JWTClaimValidationFailed) {
    if (err.claim === 'iss') return new TokenInvalid('issuer');
    if (err.claim === 'aud') return new TokenInvalid('audience');
    if (err.claim === 'nbf') return new TokenInvalid('not_yet_valid');
    return new TokenInvalid('claims');
  }
  if (
    err instanceof errors.JWSSignatureVerificationFailed ||
    err instanceof errors.JWKSNoMatchingKey ||
    err instanceof errors.JWKSMultipleMatchingKeys ||
    err instanceof errors.JOSEAlgNotAllowed
  ) {
    return new TokenInvalid('signature');
  }
  if (err instanceof errors.JWSInvalid || err instanceof errors.JWTInvalid || err instanceof errors.JOSENotSupported) {
    return new TokenInvalid('malformed');
  }
  // Timeouts, connection errors, non-200 from the JWKS endpoint, anything unrecognised: we cannot vouch for the token.
  return new KeysUnavailable(err instanceof Error ? err.message : 'key resolution failed');
}

export function remoteKeys(url: string, timeoutMs: number, cacheSeconds: number, cooldownMs = 30_000): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(url), {
    timeoutDuration: timeoutMs,
    cacheMaxAge: cacheSeconds * 1000,
    // An unknown `kid` (rotation) triggers a refetch, at most once per cooldown so garbage kids cannot hammer the IdP.
    cooldownDuration: cooldownMs,
  });
}
