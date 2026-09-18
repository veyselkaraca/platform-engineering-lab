import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createProxyMiddleware } from 'http-proxy-middleware';

export interface GatewayConfig {
  /** Path prefix -> upstream base URL, e.g. { '/v1/users': 'http://user-service:3000' }. */
  routes: Record<string, string>;
  upstreamTimeoutMs: number;
  rateLimitPerMinute: number;
  logError: (message: string) => void;
}

// When each request entered the gateway, to tell a slow upstream (504) from an unreachable one (502).
const startedAt = new WeakMap<object, number>();

const STATUS_TEXT: Record<number, string> = { 429: 'Too Many Requests', 502: 'Bad Gateway', 504: 'Gateway Timeout' };
const isHealth = (req: Request) => req.originalUrl.startsWith('/health');
const pathOf = (req: Request) => req.originalUrl.split('?')[0];

// Structured error that never leaks upstream details (AGENTS.md section 12.3).
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

  return (req, res, next) => {
    if (isHealth(req)) return next();
    const path = pathOf(req);
    const match = proxies.find(({ prefix }) => path === prefix || path.startsWith(`${prefix}/`));
    if (!match) return next(); // unknown route: falls through to the framework's 404
    void match.proxy(req, res, next);
  };
}

// Order matters: identify the request, throttle it, then route it.
export function createGateway(config: GatewayConfig): RequestHandler[] {
  return [requestId(), limiter(config.rateLimitPerMinute), router(config)];
}
