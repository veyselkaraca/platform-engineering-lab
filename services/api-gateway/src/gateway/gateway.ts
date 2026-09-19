import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { context } from '@opentelemetry/api';
import { getRPCMetadata } from '@opentelemetry/core';
import { rateLimit } from 'express-rate-limit';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { recordAuthRejection } from '../auth/auth.metrics';
import { KeysUnavailable, TokenInvalid, TokenVerifier } from '../auth/token-verifier';

export interface GatewayConfig {
  /** Path prefix -> upstream base URL, e.g. { '/v1/users': 'http://user-service:3000' }. */
  routes: Record<string, string>;
  upstreamTimeoutMs: number;
  rateLimitPerMinute: number;
  /** Validates the caller's bearer token before a request is routed; roles and ownership stay with the services. */
  verifier: TokenVerifier;
  logError: (message: string) => void;
  logWarn: (message: string) => void;
}

// When each request entered the gateway, to tell a slow upstream (504) from an unreachable one (502).
const startedAt = new WeakMap<object, number>();

const STATUS_TEXT: Record<number, string> = {
  401: 'Unauthorized',
  429: 'Too Many Requests',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};
const isHealth = (req: Request) => req.originalUrl.startsWith('/health');
const pathOf = (req: Request) => req.originalUrl.split('?')[0];

// Structured error that never leaks upstream details (engineering standards: Error handling).
function fail(res: ServerResponse | Response, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ statusCode: status, error: STATUS_TEXT[status], message }));
}

// Correlation: reuse the caller's x-request-id (or the id the logger already assigned), else create one.
// It is forwarded upstream and echoed to the client.
function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    const assigned = (req as { id?: unknown }).id;
    const id = String(assigned ?? (typeof incoming === 'string' && incoming !== '' ? incoming : randomUUID()));
    req.headers['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    startedAt.set(req, Date.now());
    next();
  };
}

// ponytail: in-memory counters are per gateway replica and keyed by the socket address; behind a load balancer
// configure `trust proxy` and use a shared (Redis) store so the limit holds across replicas.
function limiter(perMinute: number): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: isHealth, // probes must never be throttled
    handler: (_req, res) => fail(res, 429, 'Too many requests, retry later'),
  });
}

// Coarse authentication at the front door: a request without a valid token never reaches a backend. The header is
// forwarded unchanged because every service verifies the token again and authorizes by role and ownership.
// The client always gets the same generic 401; the reason is only logged. Tokens are never logged.
function authenticate(config: GatewayConfig): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const requestId = String(req.headers['x-request-id']);
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    if (!match) return reject(res, requestId, 'missing');
    try {
      await config.verifier.verify(match[1]);
    } catch (err) {
      if (err instanceof TokenInvalid) return reject(res, requestId, err.reason);
      recordAuthRejection('keys_unavailable');
      config.logError(`auth.keys_unavailable requestId=${requestId} cause=${err instanceof KeysUnavailable ? err.message : 'unexpected'}`);
      return fail(res, 503, 'Authentication is temporarily unavailable');
    }
    next();
  };

  function reject(res: Response, requestId: string, reason: string): void {
    recordAuthRejection(reason);
    config.logWarn(`auth.rejected requestId=${requestId} reason=${reason}`);
    res.setHeader('www-authenticate', 'Bearer');
    fail(res, 401, 'Invalid or missing token');
  }
}

function router(config: GatewayConfig): RequestHandler {
  const proxies = Object.entries(config.routes).map(([prefix, target]) => ({
    prefix,
    proxy: createProxyMiddleware({
      target,
      xfwd: true,
      proxyTimeout: config.upstreamTimeoutMs, // upstream must answer within this
      // Client socket guard against stalled connections. It must outlast proxyTimeout, otherwise the socket is
      // destroyed before the 504 can be written.
      timeout: config.upstreamTimeoutMs + 5000,
      on: {
        error: (err: Error & { code?: string }, req: IncomingMessage, res: ServerResponse | unknown) => {
          const timedOut = Date.now() - (startedAt.get(req) ?? Date.now()) >= config.upstreamTimeoutMs - 50;
          config.logError(
            `gateway.upstream_error requestId=${String(req.headers['x-request-id'])} target=${target} code=${err.code ?? 'unknown'} timedOut=${timedOut}`,
          );
          if (res && typeof (res as ServerResponse).setHeader === 'function') {
            fail(res as ServerResponse, timedOut ? 504 : 502, timedOut ? 'Upstream did not respond in time' : 'Upstream service unavailable');
          }
        },
      },
    }),
  }));

  const authenticated = authenticate(config);
  return (req, res, next) => {
    if (isHealth(req)) return next();
    const path = pathOf(req);
    const match = proxies.find(({ prefix }) => path === prefix || path.startsWith(`${prefix}/`));
    if (!match) return next(); // unknown route: falls through to the framework's 404
    // Telemetry: label the request by the route prefix it matched, not by the catch-all Express route it went through.
    const rpc = getRPCMetadata(context.active());
    if (rpc) rpc.route = match.prefix;
    void authenticated(req, res, (err?: unknown) => (err ? next(err) : void match.proxy(req, res, next)));
  };
}

// Order matters: identify the request, throttle it (so unauthenticated floods hit the limit before costing a
// verification), then authenticate and route it.
export function createGateway(config: GatewayConfig): RequestHandler[] {
  return [requestId(), limiter(config.rateLimitPerMinute), router(config)];
}
