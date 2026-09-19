// Helpers for the tests that run against the local compose stack (tests/{integration,contract,e2e}).
// Zero dependencies: Node's built-in test runner and fetch. Start the stack first (see CLAUDE.md).
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

export const URLS = {
  user: process.env.USER_URL ?? 'http://localhost:3001',
  order: process.env.ORDER_URL ?? 'http://localhost:3002',
  worker: process.env.WORKER_URL ?? 'http://localhost:3003',
  gateway: process.env.GATEWAY_URL ?? 'http://localhost:8080',
  keycloak: process.env.KEYCLOAK_URL ?? 'http://localhost:8081',
};

// Fixed ids of the dev realm users (security/keycloak/realm/platform-lab-dev.json): the token `sub` is the userId.
// dev-other must never get a user record: tests rely on it being a valid customer whose record does not exist.
export const IDS = {
  customer: 'c0ffee00-0000-4000-8000-000000000001',
  admin: 'c0ffee00-0000-4000-8000-000000000002',
  other: 'c0ffee00-0000-4000-8000-000000000003',
};

const ISSUER = `${URLS.keycloak}/realms/platform-lab`;

export async function tokenFor(username) {
  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'platform-lab-dev',
      username,
      password: `${username}-fake-password`,
    }),
  });
  if (!res.ok) throw new Error(`no token for ${username}: HTTP ${res.status} (is the stack up?)`);
  return (await res.json()).access_token;
}

export async function tokens() {
  const [customer, other, admin] = await Promise.all([tokenFor('dev-customer'), tokenFor('dev-other'), tokenFor('dev-admin')]);
  return { customer, other, admin };
}

// -> { status, body (parsed JSON or text), headers }
export async function call(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

// Registers a user record; an existing record (409) is fine. Users live in Keycloak; this is the platform-side record.
export async function registerUser(adminToken, { id, email, name }) {
  const res = await call('POST', `${URLS.user}/v1/users`, { token: adminToken, body: { id, email, name } });
  if (res.status !== 201 && res.status !== 409) throw new Error(`registering ${id} returned ${res.status}`);
}

export async function eventually(fn, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

// A token that looks right (issuer, audience, admin role) but is signed with a key Keycloak never published,
// or with `alg: none`. Every service must refuse it.
export function forgedToken({ alg = 'RS256', expired = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: ISSUER,
    aud: 'platform-api',
    sub: IDS.admin,
    iat: now,
    exp: expired ? now - 3600 : now + 300,
    realm_access: { roles: ['admin'] },
  };
  const header = { alg, typ: 'JWT', kid: 'not-a-keycloak-key' };
  const signingInput = `${b64(header)}.${b64(claims)}`;
  if (alg === 'none') return `${signingInput}.`;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return `${signingInput}.${sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url')}`;
}

export const uniqueEmail = () => `it-${randomUUID()}@example.invalid`;
