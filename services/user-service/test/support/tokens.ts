import { createLocalJWKSet, exportJWK, generateKeyPair, JSONWebKeySet, KeyLike, SignJWT } from 'jose';
import { TokenVerifier } from '../../src/auth/token-verifier';

export const ISSUER = 'http://idp.test/realms/lab';
export const AUDIENCE = 'platform-api';
export const CUSTOMER_ID = 'c0ffee00-0000-4000-8000-000000000001';
export const ADMIN_ID = 'c0ffee00-0000-4000-8000-000000000002';
export const OTHER_ID = 'c0ffee00-0000-4000-8000-000000000003';

export interface TestKeys {
  kid: string;
  privateKey: KeyLike;
  publicKey: KeyLike;
  jwks: JSONWebKeySet;
}

export async function makeKeys(kid = 'test-key'): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  return { kid, privateKey, publicKey, jwks: { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }] } };
}

export interface TokenOptions {
  sub?: string | null;
  roles?: string[] | null;
  iss?: string;
  aud?: string | string[];
  exp?: number; // seconds since epoch
  nbf?: number;
  kid?: string;
}

const now = () => Math.floor(Date.now() / 1000);

export async function signToken(keys: TestKeys, o: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (o.roles !== null) claims.realm_access = { roles: o.roles ?? ['customer'] };
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: o.kid ?? keys.kid })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? now() + 300);
  if (o.sub !== null) jwt.setSubject(o.sub ?? CUSTOMER_ID);
  if (o.nbf !== undefined) jwt.setNotBefore(o.nbf);
  return jwt.sign(keys.privateKey);
}

export const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function verifierFor(keys: TestKeys, clockToleranceSeconds = 5): TokenVerifier {
  return new TokenVerifier(createLocalJWKSet(keys.jwks), { issuer: ISSUER, audience: AUDIENCE, clockToleranceSeconds });
}
