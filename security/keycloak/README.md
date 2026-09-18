# Keycloak (identity provider)

Feature docs: [docs/features/identity-keycloak](../../docs/features/identity-keycloak/). This directory holds the version-controlled realm; the runtime is the `keycloak` service in `infrastructure/docker/docker-compose.yml`.

## Realm `platform-lab` (dev)

[realm/platform-lab-dev.json](realm/platform-lab-dev.json) is imported on first start (`start-dev --import-realm`).

| Item | Value |
|---|---|
| Roles | realm roles `customer`, `admin` |
| Client | `platform-lab-dev`: public, direct access grants (password grant), **dev/CI only** |
| Audience | access tokens carry `aud: platform-api` (audience mapper on the client) |
| Access token lifetime | 300 s |
| Users (**fake**, dev only) | `dev-customer` / `dev-customer-fake-password`, sub `c0ffee00-0000-4000-8000-000000000001`, role `customer` · `dev-other` / `dev-other-fake-password`, sub `c0ffee00-0000-4000-8000-000000000003`, role `customer` (a second customer, used to prove ownership checks) · `dev-admin` / `dev-admin-fake-password`, sub `c0ffee00-0000-4000-8000-000000000002`, role `admin` |

All credentials in this realm are fake and exist only for local/CI use. A test/prod realm is a separate file and must not contain test users or a direct-grant client.

## Claim mapping (what the services read)

| Claim | Use |
|---|---|
| `iss` | must equal `AUTH_ISSUER` (`http://localhost:8081/realms/platform-lab` locally; pinned by `KC_HOSTNAME`) |
| `aud` | must contain `AUTH_AUDIENCE` (`platform-api`) |
| `sub` | **is** the `userId`: `POST /v1/users` registers a user with `id = sub`; ownership checks compare `sub` to the resource's `userId` |
| `realm_access.roles` | `customer` / `admin` for role gates |

## Getting a token locally

```bash
curl -s -d grant_type=password -d client_id=platform-lab-dev \
  -d username=dev-admin -d password=dev-admin-fake-password \
  http://localhost:8081/realms/platform-lab/protocol/openid-connect/token
```

The admin console is at http://localhost:8081 (credentials `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` from `infrastructure/docker/.env`).

## Users are provisioned here, not by the platform

A user exists in Keycloak first. To let them place orders, an `admin` registers the matching record with `POST /v1/users {"id": "<their sub>", "email": ..., "name": ...}` (the smoke test does this for `dev-customer`).

## Changing the realm

`--import-realm` skips a realm that already exists, so edits to the JSON are **not** applied to a used database. To apply them locally, drop the Keycloak database and start again:

```bash
docker compose -f infrastructure/docker/docker-compose.yml stop keycloak
docker compose -f infrastructure/docker/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE keycloak WITH (FORCE)"'
docker compose -f infrastructure/docker/docker-compose.yml up -d keycloak db-init
```

(`db-init` recreates the empty database.) Real environments will manage the realm through their own automation.
