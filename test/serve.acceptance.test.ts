import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { credentialStore } from '../src/auth/store.js';
import { BUNDLE, runBundle } from './bundle.js';

// Outside-in: these tests drive the shipped bundle exactly as an MCP client does.

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const READ_TOOLS = [
  'bwat_inbox_list',
  'bwat_inbox_get',
  'bwat_inbox_mark_read',
  'bwat_meetings_list',
  'bwat_transcript_get',
  'bwat_status',
  'bwat_cards_list',
  'bwat_bot_meetings',
  'bwat_bot_join',
  'bwat_bot_recall',
  'bwat_login',
  'bwat_logout',
];

async function connect(...args: string[]): Promise<Client> {
  const client = new Client({ name: 'acceptance', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [BUNDLE, 'serve', ...args], stderr: 'pipe' }),
  );
  return client;
}

let generic: Client;
let codex: Client;

beforeAll(async () => {
  [generic, codex] = await Promise.all([connect('--client', 'generic'), connect('--client', 'codex')]);
});

afterAll(async () => {
  await Promise.all([generic?.close(), codex?.close()]);
});

test('serve speaks MCP as the "bwat" server, at the package version, and tells the model content is untrusted', () => {
  expect(generic.getServerVersion()).toMatchObject({ name: 'bwat', version: PKG.version });
  expect(generic.getInstructions()).toMatch(/untrusted/i);
});

test('a generic client gets the tools in a fixed order and no session binding', async () => {
  const { tools } = await generic.listTools();
  expect(tools.map((t) => t.name)).toEqual(READ_TOOLS);
});

test('a Codex client also gets bwat_session_bind, last', async () => {
  const { tools } = await codex.listTools();
  expect(tools.map((t) => t.name)).toEqual([...READ_TOOLS, 'bwat_session_bind']);
});

test('mark-read takes exactly one message id and nothing else', async () => {
  const { tools } = await generic.listTools();
  expect(tools.find((t) => t.name === 'bwat_inbox_mark_read')?.inputSchema).toMatchObject({
    type: 'object',
    properties: { message_id: { type: 'string' } },
    required: ['message_id'],
    additionalProperties: false,
  });
});

test('the session binding refuses an id bwat would not accept, before any request', async () => {
  const result = await codex.callTool({ name: 'bwat_session_bind', arguments: { session_id: 's', event: 'stop' } });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ code: 'invalid_arguments' });
});

test.each([
  ['a missing message id', 'bwat_inbox_mark_read', {}],
  ['an array of message ids', 'bwat_inbox_mark_read', { message_id: ['a', 'b'] }],
  ['an extra property', 'bwat_inbox_get', { message_id: 'a', mark_read: true }],
  ['arguments to a tool that takes none', 'bwat_status', { verbose: true }],
])('%s is refused as invalid_arguments before the tool runs', async (_label, name, args) => {
  const result = await generic.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ code: 'invalid_arguments' });
});

test.each([
  ['a tool that does not exist', 'bwat_nonsense'],
  ['a Codex-only tool on a generic client', 'bwat_session_bind'],
])('%s is a JSON-RPC invalid-params error, not a tool result', async (_label, name) => {
  await expect(generic.callTool({ name, arguments: {} })).rejects.toMatchObject({ code: -32602 });
});

// Claude Code and Codex start the server with no Google client in its environment: the stored one is used.
test('a sign-in about to expire is refreshed with Google before the first tool call reaches the backend', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bwat-home-'));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const refreshed = `${part({ alg: 'RS256' })}.${part({ email: 'member@bwat.example', sub: '42', exp })}.sig`;
  const grants: string[] = [];
  const google = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      grants.push(`${form.get('grant_type')} ${form.get('client_id')}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id_token: refreshed }));
    });
  });
  const bearers: (string | undefined)[] = [];
  const backend = createServer((req, res) => {
    bearers.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ meetings: [], next_cursor: null }));
  });
  await Promise.all([google, backend].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
  const port = (s: typeof google) => (s.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port(backend)}/v1`;
  credentialStore(new URL(baseUrl), home).save({
    email: 'member@bwat.example', sub: '42', id_token: 'eyJ.stale.sig', refresh_token: '1//refresh',
    client_id: 'desktop-client.apps.googleusercontent.com', expires_at: new Date(Date.now() + 30_000).toISOString(),
  });

  const client = new Client({ name: 'acceptance', version: '0.0.0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', pathToFileURL(fileURLToPath(new URL('./google-preload.mjs', import.meta.url))).href, BUNDLE, 'serve'],
        env: {
          ...(process.env as Record<string, string>),
          BWAT_GOOGLE_CLIENT_ID: '',
          BWAT_GOOGLE_CLIENT_SECRET: '',
          BWAT_HOME: home,
          BWAT_BASE_URL: baseUrl,
          BWAT_TEST_GOOGLE_TOKEN_URL: `http://127.0.0.1:${port(google)}/token`,
        },
        stderr: 'pipe',
      }),
    );
    const result = await client.callTool({ name: 'bwat_meetings_list', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(grants).toEqual(['refresh_token desktop-client.apps.googleusercontent.com']);
    expect(bearers).toEqual([`Bearer ${refreshed}`]);
  } finally {
    await client.close();
    for (const s of [google, backend]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test('--version prints the package version and exits', () => {
  const run = runBundle(['--version']);
  expect(run.status).toBe(0);
  expect(run.stdout).toBe(`${PKG.version}\n`);
});

test('an unknown subcommand exits non-zero without starting a server', () => {
  const run = runBundle(['nonsense']);
  expect(run.status).not.toBe(0);
  expect(run.stdout).toBe('');
});

test.each([
  ['an unknown --client value', ['serve', '--client', 'emacs']],
  ['an unknown flag', ['serve', '--bogus']],
])('%s exits non-zero', (_label, args) => {
  const run = runBundle(args);
  expect(run.status).not.toBe(0);
});
