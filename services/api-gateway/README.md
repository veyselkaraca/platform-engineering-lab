# api-gateway

The single entry point: routes public requests to the backend services, guarantees every request has a correlation id, throttles clients and turns backend failures into clean errors. See [ADR-001](../../docs/decisions/ADR-001-stack-and-service-responsibilities.md).

**Not implemented yet:** JWT verification and authorization. It arrives with the Keycloak slice and belongs here, at the edge (services will verify tokens again themselves, per ADR-001). Until then do not expose the gateway beyond a trusted network.

## Routes

| Public path prefix | Upstream | Notes |
|---|---|---|
| `/v1/users` | user-service | |
| `/v1/orders` | order-service | `Idempotency-Key` and request bodies are forwarded untouched |
| `/v1/notifications` | notification-worker | read-only lookup |
| `/health/live`, `/health/ready` | the gateway itself | never proxied, never throttled |

Anything else answers 404 without touching a backend. Matching is by whole path segment (`/v1/users-admin` is not `/v1/users`). Query strings, methods, status codes and bodies of backend answers pass through unchanged, including backend 4xx/5xx.

## Behaviour

- **Correlation:** `x-request-id` is reused from the caller or generated, forwarded to the backend and echoed in the response. It is also the logger's request id, so one id ties together gateway, service and (via the event's `correlationId`) worker log lines.
- **Failures:** backend unreachable -> `502`, no answer within `UPSTREAM_TIMEOUT_MS` -> `504`, both as `{statusCode, error, message}` with no upstream address or internals. The cause (target, error code, request id) is logged as `gateway.upstream_error`.
- **Isolation:** one backend being down only breaks its own routes. Readiness deliberately does **not** depend on the backends: failing it would take the whole gateway out of rotation and turn a partial outage into a total one.
- **Rate limiting:** `RATE_LIMIT_PER_MINUTE` requests per client per minute, `429` beyond that, standard `RateLimit` headers. The limiter is in memory, so the limit applies per gateway replica and clients are keyed by socket address. Behind a load balancer configure `trust proxy` and switch to a shared (Redis) store.
- **Bodies are not parsed:** the gateway streams them through, so it needs no schema knowledge of the backends.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `USER_SERVICE_URL`, `ORDER_SERVICE_URL`, `NOTIFICATION_WORKER_URL` | required | Backend base URLs |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Must exceed the slowest legitimate call (order creation does a user lookup and a broker publish) |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per client per gateway replica |
| `PORT` | `3000` | Listen port |
| `LOG_LEVEL` | `info` | pino level |

Sample fake values: `.env.example`. Startup fails on missing or invalid values.

## Commands

```bash
npm ci
npm run lint
npm test
npm run build
```

The tests use real HTTP stub backends: `test/gateway.spec.ts` covers routing, correlation, 502/504, throttling with plain Express; `test/app.spec.ts` boots the whole Nest application. Full stack (from the repo root): `sh scripts/bootstrap.sh`, `docker compose -f infrastructure/docker/docker-compose.yml up -d --build`, then `sh scripts/smoke-test.sh http://localhost:3001 http://localhost:3002 http://localhost:3003 http://localhost:8080`. The gateway listens on `http://localhost:8080`. Debug in Docker with the dev overlay and **api-gateway: attach (docker)** (port 9232).

## Operational notes

- **Why it exists / owns:** one public surface and edge concerns (correlation, throttling, later authentication); it owns no data.
- **Depends on:** the backends per route only (soft).
- **On failure:** a backend outage -> 502/504 for that route; the gateway itself has no external hard dependency.
- **Observed:** JSON logs (pino) with the request id, probe requests not logged, `authorization`/`cookie` redacted. Metrics (request/error rate, latency, 429 count) and traces arrive with the observability slice.
- **Image:** multi-stage, non-root, `HEALTHCHECK`, npm removed from the runtime stage, tag `api-gateway:<commit-sha>`.
- **CI:** `.github/workflows/api-gateway.yml`; its smoke test runs a user, an order and the asynchronous notification through the gateway in front of the real backends.
- **Rollback:** redeploy the previous image tag. The gateway is stateless, so nothing needs restoring.
- **Shutdown:** SIGTERM stops accepting connections and drains in-flight requests.

## Dependency notes

NestJS is pinned to the 11 line (CommonJS); `multer` is overridden to a patched release (see the user-service README). `http-proxy-middleware` pulls in `http-proxy`, which triggers Node's one-time `DEP0060` (`util._extend`) deprecation warning at runtime; it is harmless and goes away when the library drops that call.
