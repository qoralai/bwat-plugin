import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, type ApiClient, createApiClient } from '../../src/api/client.js';

/**
 * The API client every backend tool goes through. A local HTTP server stands in for the bwat
 * backend here; the tools themselves are tested against the real backend in Docker.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let handler: Handler;
let seen: { method?: string; url?: string; authorization?: string }[];
let base: URL;

beforeEach(async () => {
  seen = [];
  handler = (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const TOKEN = 'id-token-abc';
let made: ApiClient[] = [];
const client = (overrides: Partial<Parameters<typeof createApiClient>[0]> = {}) => {
  const c = createApiClient({ baseUrl: base, token: async () => TOKEN, env: {}, ...overrides });
  made.push(c);
  return c;
};
afterEach(async () => {
  await Promise.all(made.map((c) => c.close()));
  made = [];
});
const json = (status: number, body: unknown): Handler => (_req, res) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

describe('requests', () => {
  it('sends the bearer token to <base>/<path> with query parameters', async () => {
    handler = json(200, { messages: [] });
    await expect(client().get(['me', 'inbox'], { scope: 'all', limit: 5 })).resolves.toEqual({ messages: [] });
    expect(seen).toEqual([{ method: 'GET', url: '/v1/me/inbox?scope=all&limit=5', authorization: `Bearer ${TOKEN}` }]);
  });

  it('sends JSON bodies and returns undefined for 204', async () => {
    let body = '';
    handler = (req, res) => {
      req.on('data', (c) => (body += c));
      req.on('end', () => res.writeHead(204).end());
    };
    await expect(client().patch(['me', 'inbox', 'abc'])).resolves.toBeUndefined();
    await expect(client().post(['handoffs'], { a: 1 })).resolves.toBeUndefined();
    expect(body).toBe('{"a":1}');
  });

  it('sends nothing when there is no token', async () => {
    await expect(client({ token: async () => undefined }).get(['me'])).rejects.toMatchObject({ code: 'not_signed_in' });
    expect(seen).toEqual([]);
  });

  it('lets a failure to read the token surface as itself', async () => {
    const boom = new Error('EACCES reading credential');
    await expect(client({ token: async () => Promise.reject(boom) }).get(['me'])).rejects.toBe(boom);
    expect(seen).toEqual([]);
  });
});

describe('the URL never leaves the backend', () => {
  it.each([
    ['no segments', []],
    ['an empty segment', ['me', '']],
    ['a dot segment', ['.']],
    ['a dot-dot segment', ['me', '..', 'health']],
    ['a lone surrogate, which cannot be encoded', ['me', 'inbox', 'a\uD800']],
  ])('refuses %s before sending anything', async (_label, path) => {
    await expect(client().get(path)).rejects.toMatchObject({ code: 'bad_path' });
    expect(seen).toEqual([]);
  });

  it.each([
    ['an absolute URL', 'https://evil.example/x', '/v1/me/inbox/https%3A%2F%2Fevil.example%2Fx'],
    ['a slash', 'a/../../health', '/v1/me/inbox/a%2F..%2F..%2Fhealth'],
    ['an encoded dot-dot', '%2e%2e', '/v1/me/inbox/%252e%252e'],
    ['a backslash', 'a\\b', '/v1/me/inbox/a%5Cb'],
    ['a query and fragment', 'x?y=1#z', '/v1/me/inbox/x%3Fy%3D1%23z'],
  ])('encodes %s inside one segment, so it stays under the API root', async (_label, id, sent) => {
    await client().get(['me', 'inbox', id]);
    expect(seen.map((r) => r.url)).toEqual([sent]);
  });

  it('refuses a base URL the guard refuses', () => {
    expect(() => createApiClient({ baseUrl: new URL('http://bwat.example/v1'), token: async () => TOKEN })).toThrow(/https/);
  });

  it('an open request sends no token, and is still refused a redirect', async () => {
    handler = json(200, { client_id: 'x' });
    await expect(client({ token: async () => undefined }).getOpen(['auth', 'desktop-client'])).resolves.toEqual({ client_id: 'x' });
    expect(seen).toEqual([{ method: 'GET', url: '/v1/auth/desktop-client', authorization: undefined }]);
    handler = (_req, res) => res.writeHead(302, { location: 'https://evil.example/steal' }).end();
    await expect(client().getOpen(['auth', 'desktop-client'])).rejects.toMatchObject({ code: 'redirect_refused' });
  });

  it('never follows a redirect', async () => {
    handler = (_req, res) => res.writeHead(302, { location: 'https://evil.example/steal' }).end();
    await expect(client().get(['me'])).rejects.toMatchObject({ code: 'redirect_refused', status: 302 });
    expect(seen).toHaveLength(1);
  });
});

describe('responses', () => {
  it('maps a known error code with its status', async () => {
    handler = json(404, { error: 'not_found' });
    await expect(client().get(['me', 'inbox', 'x'])).rejects.toEqual(new ApiError('not_found', 404));
  });

  it('does not repeat an unknown error code, which could echo anything', async () => {
    handler = json(400, { error: 'Bearer id-token-abc is bad' });
    const err = (await client().get(['me']).catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ code: 'backend_error', status: 400 });
    expect(JSON.stringify(err) + err.message).not.toContain(TOKEN);
  });

  it('keeps the status when an error body is not JSON', async () => {
    handler = (_req, res) => res.writeHead(401, { 'content-type': 'text/html' }).end('<h1>no</h1>');
    await expect(client().get(['me'])).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('calls an empty 200 a bad response: only 204 means no body', async () => {
    handler = (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('');
    await expect(client().get(['me'])).rejects.toMatchObject({ code: 'bad_response', status: 200 });
  });

  it('calls a malformed success body a bad response, not a transport failure', async () => {
    handler = (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{nope');
    await expect(client().get(['me'])).rejects.toMatchObject({ code: 'bad_response', status: 200 });
  });

  it('refuses a response body over the size limit', async () => {
    handler = (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(`"${'x'.repeat(2048)}"`);
    await expect(client({ maxResponseBytes: 1024 }).get(['me'])).rejects.toMatchObject({ code: 'too_large_response' });
  });

  it('times out a body that never finishes', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"slow":');
    };
    await expect(client({ timeoutMs: 300 }).get(['me'])).rejects.toMatchObject({ code: 'timeout' });
  });

  it('calls an unreachable backend unavailable', async () => {
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    server = createServer();
    await expect(
      client({ baseUrl: new URL(`http://127.0.0.1:${port}/v1`) }).get(['me']),
    ).rejects.toMatchObject({ code: 'backend_unavailable' });
  });
});

describe('proxies', () => {
  let proxy: NetServer;
  let connects: string[];
  beforeEach(async () => {
    connects = [];
    proxy = createNetServer((socket) => {
      socket.once('data', (d) => {
        connects.push(d.toString().split('\r\n')[0] ?? '');
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  });
  afterEach(() => new Promise<void>((r) => proxy.close(() => r())));
  const proxyUrl = () => `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  it('never sends a loopback request through a proxy, even when one is configured', async () => {
    const env = { HTTP_PROXY: proxyUrl(), HTTPS_PROXY: proxyUrl(), NO_PROXY: '' };
    await expect(client({ env }).get(['me'])).resolves.toEqual({ ok: true });
    expect(connects).toEqual([]);
  });

  const remote = (env: Record<string, string>) =>
    client({ baseUrl: new URL('https://bwat.invalid/v1'), env, timeoutMs: 1500 })
      .get(['me'])
      .catch(() => undefined);

  it('reads proxies only from the env it is given, never the process environment', async () => {
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = proxyUrl();
    try {
      await remote({});
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
    }
    expect(connects).toEqual([]);
  });

  it('honours NO_PROXY for https', async () => {
    await remote({ HTTPS_PROXY: proxyUrl(), NO_PROXY: 'bwat.invalid' });
    expect(connects).toEqual([]);
  });

  it('prefers the lower-case variable when both spellings are set, as undici does', async () => {
    await remote({ HTTPS_PROXY: proxyUrl(), no_proxy: 'bwat.invalid', NO_PROXY: '' });
    expect(connects).toEqual([]);
  });

  it('sends a remote https request through the configured proxy', async () => {
    const env = { HTTPS_PROXY: proxyUrl() };
    await client({ baseUrl: new URL('https://bwat.example/v1'), env, timeoutMs: 2000 })
      .get(['me'])
      .catch(() => undefined);
    expect(connects[0]).toMatch(/^CONNECT bwat\.example:443 /);
  });
});

describe('lifetime', () => {
  it('closes its connections when asked', async () => {
    const c = createApiClient({ baseUrl: base, token: async () => TOKEN, env: {} });
    await c.get(['me']);
    await expect(c.close()).resolves.toBeUndefined();
  });
});
