import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bwatApi } from '../../src/api/bwat.js';
import { type ApiClient, createApiClient } from '../../src/api/client.js';

/** Each typed route sends the method, path and query the backend README documents. */
let server: Server;
let seen: { method?: string; url?: string }[];
let api: ReturnType<typeof bwatApi>;
let client: ApiClient;

beforeEach(async () => {
  seen = [];
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  client = createApiClient({ baseUrl: base, token: async () => 'token', env: {} });
  api = bwatApi(client);
});
afterEach(async () => {
  await client.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('bwatApi', () => {
  it.each([
    ['me', () => api.me(), 'GET', '/v1/me'],
    [
      'the inbox',
      () => api.inbox({ scope: 'session', client_session: 'sess-0001', unread_only: true, cursor: 'c1' }),
      'GET',
      '/v1/me/inbox?scope=session&client_session=sess-0001&unread_only=true&cursor=c1',
    ],
    ['one message', () => api.inboxMessage(ID), 'GET', `/v1/me/inbox/${ID}`],
    ['mark read', () => api.markRead(ID), 'PATCH', `/v1/me/inbox/${ID}`],
    ['the history', () => api.meetings({ cursor: 'c2' }), 'GET', '/v1/meetings?cursor=c2'],
    ['a transcript by meeting id', () => api.transcript(ID, {}), 'GET', `/v1/meetings/${ID}/transcript`],
    [
      'a transcript by Zoom occurrence, URL-encoded once',
      () => api.transcript('mtg/Occ+1==', { cursor: 'c3' }),
      'GET',
      '/v1/meetings/mtg%2FOcc%2B1%3D%3D/transcript?cursor=c3',
    ],
  ])('%s', async (_label, call, method, url) => {
    await call();
    expect(seen).toEqual([{ method, url }]);
  });
});
