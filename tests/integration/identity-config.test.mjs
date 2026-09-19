// Static checks on identity configuration: no stack needed.
// ID-9 (test users and direct grants only in the dev realm), IDN-1 (only clearly fake credentials),
// IDN-6 (short token lifetime), IDN-9 (no auth-off switch anywhere).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const realmDir = join(root, 'security/keycloak/realm');
const realms = readdirSync(realmDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, json: JSON.parse(readFileSync(join(realmDir, f), 'utf8')) }));

describe('Keycloak realm files', () => {
  it('include the dev realm', () => assert.ok(realms.some((r) => r.file.endsWith('-dev.json'))));

  for (const { file, json } of realms) {
    describe(file, () => {
      it('defines the customer and admin roles', () => {
        const names = json.roles.realm.map((r) => r.name);
        assert.ok(names.includes('customer') && names.includes('admin'));
      });

      it('has short-lived access tokens (IDN-6)', () => assert.ok(json.accessTokenLifespan <= 600));

      it('does not allow self-registration', () => assert.notEqual(json.registrationAllowed, true));

      if (file.endsWith('-dev.json')) {
        it('only uses clearly fake credentials and reserved example addresses (IDN-1)', () => {
          for (const user of json.users) {
            assert.match(user.email, /@example\.invalid$/, `${user.username} email`);
            for (const c of user.credentials ?? []) assert.match(c.value, /fake/, `${user.username} password must say it is fake`);
          }
        });

        it('pins fixed UUIDs for its users so sub == userId is scriptable', () => {
          for (const user of json.users) assert.match(user.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
        });
      } else {
        // ID-9: an environment realm must not carry test users or a password-grant client.
        it('has no users and no direct-grant clients (ID-9)', () => {
          assert.deepEqual(json.users ?? [], []);
          assert.ok(!(json.clients ?? []).some((c) => c.directAccessGrantsEnabled));
        });
      }
    });
  }
});

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.(ts|js|ya?ml|sh)$/.test(name)) yield p;
  }
}

describe('no way to switch authentication off (IDN-9)', () => {
  it('appears nowhere in services, compose files or scripts', () => {
    const offenders = [];
    for (const dir of ['services', 'infrastructure', 'scripts']) {
      for (const file of sources(join(root, dir))) {
        if (/\b(AUTH_DISABLED|DISABLE_AUTH|SKIP_AUTH|NO_AUTH)\b/.test(readFileSync(file, 'utf8'))) offenders.push(file);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe('sample environment file (IDN-1)', () => {
  it('holds only placeholder secrets', () => {
    const env = readFileSync(join(root, 'infrastructure/docker/.env.example'), 'utf8');
    for (const line of env.split('\n')) {
      const [key, value = ''] = line.split('=');
      if (/PASSWORD|SECRET|TOKEN/.test(key)) assert.match(value, /change-me/, `${key} must be an obvious placeholder`);
    }
  });
});
