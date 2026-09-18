import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { KeysUnavailable, remoteKeys, TokenInvalid, TokenVerifier } from '../src/auth/token-verifier';
import { AUDIENCE, ISSUER, makeKeys, signToken, TestKeys } from './support/tokens';

// The verifier against a real HTTP JWKS endpoint we can stop, slow down and rotate (IDN-3, IDN-4).
class Jwks {
  requests = 0;
  delayMs = 0;
  keys: TestKeys[] = [];
  private server!: Server;
  private timers = new Set<NodeJS.Timeout>();
  port = 0;

  async start(port = 0) {
    this.server = createServer((_req, res) => {
      this.requests++;
      const t = setTimeout(() => {
        this.timers.delete(t);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: this.keys.flatMap((k) => k.jwks.keys) }));
      }, this.delayMs);
      this.timers.add(t);
    });
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  stop() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.server.closeAllConnections();
    return new Promise<void>((r) => this.server.close(() => r()));
  }
  get url() {
    return `http://127.0.0.1:${this.port}/certs`;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const opts = { issuer: ISSUER, audience: AUDIENCE, clockToleranceSeconds: 5 };

describe('TokenVerifier with a remote JWKS', () => {
  let jwks: Jwks;
  let keys: TestKeys;

  beforeEach(async () => {
    keys = await makeKeys('k1');
    jwks = new Jwks();
    jwks.keys = [keys];
    await jwks.start();
  });
  afterEach(async () => {
    await jwks.stop().catch(() => undefined);
  });

  it('fetches keys once, then serves from the cache', async () => {
    const v = new TokenVerifier(remoteKeys(jwks.url, 500, 60), opts);
    await v.verify(await signToken(keys));
    await v.verify(await signToken(keys));
    expect(jwks.requests).toBe(1);
  });

  it('keeps accepting tokens while the IdP is down and the cache is warm', async () => {
    const v = new TokenVerifier(remoteKeys(jwks.url, 500, 60), opts);
    await v.verify(await signToken(keys));
    await jwks.stop();
    await expect(v.verify(await signToken(keys))).resolves.toBeDefined();
  });

  it('fails closed (KeysUnavailable) once the cache expired and the IdP is still down', async () => {
    const v = new TokenVerifier(remoteKeys(jwks.url, 300, 0.2), opts);
    await v.verify(await signToken(keys));
    await jwks.stop();
    await sleep(300);
    await expect(v.verify(await signToken(keys))).rejects.toBeInstanceOf(KeysUnavailable);
  });

  it('fails closed on a cold start with the IdP down', async () => {
    await jwks.stop();
    const v = new TokenVerifier(remoteKeys(jwks.url, 300, 60), opts);
    await expect(v.verify(await signToken(keys))).rejects.toBeInstanceOf(KeysUnavailable);
  });

  it('gives up on a slow IdP after the timeout instead of hanging', async () => {
    jwks.delayMs = 2000;
    const v = new TokenVerifier(remoteKeys(jwks.url, 200, 60), opts);
    const started = Date.now();
    await expect(v.verify(await signToken(keys))).rejects.toBeInstanceOf(KeysUnavailable);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('recovers without a restart once the IdP is back', async () => {
    const port = jwks.port;
    await jwks.stop();
    const v = new TokenVerifier(remoteKeys(jwks.url, 300, 60, 1), opts);
    await expect(v.verify(await signToken(keys))).rejects.toBeInstanceOf(KeysUnavailable);
    await jwks.start(port);
    await sleep(10);
    await expect(v.verify(await signToken(keys))).resolves.toBeDefined();
  });

  it('picks up a rotated key on the first unknown kid', async () => {
    const v = new TokenVerifier(remoteKeys(jwks.url, 500, 60, 1), opts);
    await v.verify(await signToken(keys));
    const rotated = await makeKeys('k2');
    jwks.keys = [keys, rotated];
    await sleep(10);
    await expect(v.verify(await signToken(rotated))).resolves.toBeDefined();
    expect(jwks.requests).toBe(2);
  });

  it('does not refetch for every unknown kid within the cooldown', async () => {
    const v = new TokenVerifier(remoteKeys(jwks.url, 500, 60), opts); // default 30 s cooldown
    await v.verify(await signToken(keys));
    const stranger = await makeKeys('unknown');
    for (let i = 0; i < 5; i++) {
      await expect(v.verify(await signToken(stranger))).rejects.toBeInstanceOf(TokenInvalid);
    }
    expect(jwks.requests).toBe(1);
  });
});
