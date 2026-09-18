import { SignJWT } from 'jose';
import { KeysUnavailable, RejectReason, TokenInvalid, TokenVerifier } from '../src/auth/token-verifier';
import { ADMIN_ID, AUDIENCE, b64url, CUSTOMER_ID, ISSUER, makeKeys, signToken, TestKeys, verifierFor } from './support/tokens';

const now = () => Math.floor(Date.now() / 1000);

describe('TokenVerifier', () => {
  let keys: TestKeys;
  let verifier: TokenVerifier;

  beforeAll(async () => {
    keys = await makeKeys();
    verifier = verifierFor(keys);
  });

  const reasonOf = async (token: string): Promise<RejectReason> => {
    const err = await verifier.verify(token).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TokenInvalid);
    return (err as TokenInvalid).reason;
  };

  it('accepts a valid customer token', async () => {
    expect(await verifier.verify(await signToken(keys))).toEqual({ sub: CUSTOMER_ID, roles: ['customer'] });
  });

  it('accepts a valid admin token', async () => {
    expect(await verifier.verify(await signToken(keys, { sub: ADMIN_ID, roles: ['admin'] }))).toEqual({ sub: ADMIN_ID, roles: ['admin'] });
  });

  it('accepts a token that expired within the clock tolerance', async () => {
    await expect(verifier.verify(await signToken(keys, { exp: now() - 2 }))).resolves.toBeDefined();
  });

  it('gives a token without realm_access no roles (a role gate then answers 403, not 401)', async () => {
    expect((await verifier.verify(await signToken(keys, { roles: null }))).roles).toEqual([]);
  });

  it('rejects an expired token', async () => expect(await reasonOf(await signToken(keys, { exp: now() - 3600 }))).toBe('expired'));
  it('rejects a token that is not valid yet', async () => expect(await reasonOf(await signToken(keys, { nbf: now() + 3600 }))).toBe('not_yet_valid'));
  it('rejects another issuer', async () => expect(await reasonOf(await signToken(keys, { iss: 'http://other/realms/x' }))).toBe('issuer'));
  it('rejects another audience', async () => expect(await reasonOf(await signToken(keys, { aud: 'account' }))).toBe('audience'));
  it('accepts an audience list that contains ours', async () => {
    await expect(verifier.verify(await signToken(keys, { aud: ['account', AUDIENCE] }))).resolves.toBeDefined();
  });
  it('rejects a token signed by an unknown key', async () => {
    const other = await makeKeys('other-key');
    expect(await reasonOf(await signToken(other))).toBe('signature');
  });
  it('rejects a known kid with a different key', async () => {
    const other = await makeKeys(keys.kid);
    expect(await reasonOf(await signToken(other))).toBe('signature');
  });
  it('rejects a tampered payload', async () => {
    const [h, , s] = (await signToken(keys)).split('.');
    const forged = b64url({ iss: ISSUER, aud: AUDIENCE, sub: ADMIN_ID, exp: now() + 300, realm_access: { roles: ['admin'] } });
    expect(await reasonOf(`${h}.${forged}.${s}`)).toBe('signature');
  });
  it('rejects alg none', async () => {
    const token = `${b64url({ alg: 'none' })}.${b64url({ iss: ISSUER, aud: AUDIENCE, sub: ADMIN_ID, exp: now() + 300 })}.`;
    await reasonOf(token);
  });
  it('rejects HS256 signed with the public key as the secret', async () => {
    const secret = new TextEncoder().encode(JSON.stringify(keys.jwks.keys[0]));
    const token = await new SignJWT({ realm_access: { roles: ['admin'] } })
      .setProtectedHeader({ alg: 'HS256', kid: keys.kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(ADMIN_ID)
      .setExpirationTime(now() + 300)
      .sign(secret);
    await reasonOf(token);
  });
  it.each(['', 'garbage', 'a.b.c', 'a.b'])('rejects a malformed token %p', async (t) => {
    await reasonOf(t);
  });
  it('rejects a missing sub', async () => expect(await reasonOf(await signToken(keys, { sub: null }))).toBe('claims'));
  it('rejects a sub that is not a UUID', async () => expect(await reasonOf(await signToken(keys, { sub: 'alice' }))).toBe('claims'));

  it('reports unavailable keys as KeysUnavailable, never as a token problem', async () => {
    const broken = new TokenVerifier(
      () => Promise.reject(new Error('connect ECONNREFUSED')),
      { issuer: ISSUER, audience: AUDIENCE, clockToleranceSeconds: 5 },
    );
    await expect(broken.verify(await signToken(keys))).rejects.toBeInstanceOf(KeysUnavailable);
  });
});
