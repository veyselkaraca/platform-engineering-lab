import http, { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

const ok: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
};

// A real HTTP server standing in for a backend service; records every request it receives.
export async function startUpstream(handler: Handler = ok) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// A URL that nothing listens on (connection refused).
export async function deadUrl(): Promise<string> {
  const server = await startUpstream();
  await server.close();
  return server.url;
}
