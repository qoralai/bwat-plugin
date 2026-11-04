import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialStore } from '../src/auth/store.js';
import { BUNDLE } from './bundle.js';

// Outside-in: what /bwat:join, /bwat:recall, /bwat:cards, /bwat:login,
// /bwat:logout, /bwat:inbox-off and /bwat:inbox-on run, through the shipped
// bundle, against a local server answering as the bwat backend (and Google's token endpoint).

const TOKEN = 'eyJ.id-token-secret.sig';
const SESSION = '5b0e7c1a-2f4d-4e8b-9a31-c6d7e8f90a1b';
const MEETING_ID = '0b9e8d7c-6b5a-4f39-8a27-160514f3e2d1';
const ALLOCATION_ID = '7c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e';
const ME = { id: '11111111-2222-4333-8444-555555555555', email: 'dev-person@bwat.invalid', display_name: null, role: 'owner' };
const ALLOCATION = {
  id: ALLOCATION_ID, meeting_number: '81234567890', occurrence_id: null, claim_state: 'pending',
  refused_reason: null, error: null, settings: {},
};
const CARD = { id: '22222222-3333-4444-8555-666666666666', display_id: 'T-1', kind: 'task', title: 'Ship the release on Friday' };
const PRELOAD = pathToFileURL(fileURLToPath(new URL('./google-preload.mjs', import.meta.url))).href;

type Reply = [number, unknown?];
let routes: Record<string, Reply>;
let seen: { method?: string; url?: string; authorization?: string; body?: unknown }[];
let server: Server;
let baseUrl: string;
let home: string;
let config: string;
let mcp: Client | undefined;

beforeEach(async () => {
  seen = [];
  routes = {};
  server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      // Google's token endpoint, which the preload points the bundle at: a form, not JSON.
      if (req.url === '/google/token') {
        seen.push({ method: req.method, url: req.url });
        const claims = Buffer.from(JSON.stringify({ email: ME.email, sub: 'sub-1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id_token: `eyJ.${claims}.sig`, refresh_token: '1//r', expires_in: 3599 }));
        return;
      }
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: text ? JSON.parse(text) : undefined });
      const [status, body] = routes[`${req.method} ${req.url}`] ?? [404, { error: 'not_found' }];
      if (body === undefined) res.writeHead(status).end();
      else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  home = mkdtempSync(join(tmpdir(), 'bwat-home-'));
  config = mkdtempSync(join(tmpdir(), 'bwat-claude-'));
});

afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(home, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });
});

const store = () => credentialStore(new URL(baseUrl), home);
function signIn() {
  store().save({ email: ME.email, sub: 'sub-1', id_token: TOKEN, client_id: 'unused', expires_at: '2099-01-01T00:00:00.000Z' });
}

async function connect(client = 'generic', env: Record<string, string> = {}): Promise<Client> {
  mcp = new Client({ name: 'acceptance', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', PRELOAD, BUNDLE, 'serve', '--client', client],
      env: {
        ...(process.env as Record<string, string>),
        BWAT_HOME: home, BWAT_BASE_URL: baseUrl, CLAUDE_CONFIG_DIR: config,
        CLAUDE_CODE_SESSION_ID: '', CLAUDE_CODE_MESSAGING_SOCKET: '',
        BWAT_NO_BROWSER: '1', BWAT_TEST_GOOGLE_TOKEN_URL: `${baseUrl.replace(/\/v1$/, '')}/google/token`,
        ...env,
      },
      stderr: 'pipe',
    }),
  );
  return mcp;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await (mcp ?? (await connect())).callTool({ name, arguments: args });
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  return result;
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
};

describe('the bot: send bwat to a meeting, see where it is, recall it', () => {
  beforeEach(signIn);

  it('bwat_bot_join sends bwat to the meeting a Zoom link names', async () => {
    routes['POST /v1/allocations'] = [202, ALLOCATION];
    const result = await call('bwat_bot_join', { zoom_url: 'https://zoom.us/j/81234567890?pwd=abc' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(ALLOCATION);
    expect(seen).toEqual([
      { method: 'POST', url: '/v1/allocations', authorization: `Bearer ${TOKEN}`, body: { zoom_url: 'https://zoom.us/j/81234567890?pwd=abc' } },
    ]);
  });

  it('bwat_bot_join says so when the link is not a Zoom meeting', async () => {
    routes['POST /v1/allocations'] = [422, { error: 'not_a_zoom_meeting_link' }];
    const result = await call('bwat_bot_join', { zoom_url: 'https://example.com' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: 'not_a_zoom_meeting_link', hint: expect.stringMatching(/Zoom meeting link/) });
  });

  it('bwat_bot_meetings lists where bwat is sent', async () => {
    routes['GET /v1/allocations'] = [200, { allocations: [ALLOCATION] }];
    expect((await call('bwat_bot_meetings')).structuredContent).toEqual({ allocations: [ALLOCATION] });
  });

  it('bwat_bot_recall recalls bwat from one meeting', async () => {
    routes[`PATCH /v1/allocations/${ALLOCATION_ID}`] = [200, { ...ALLOCATION, claim_state: 'ended' }];
    const result = await call('bwat_bot_recall', { allocation_id: ALLOCATION_ID });
    expect(result.structuredContent).toMatchObject({ id: ALLOCATION_ID });
    expect(seen).toEqual([
      { method: 'PATCH', url: `/v1/allocations/${ALLOCATION_ID}`, authorization: `Bearer ${TOKEN}`, body: { recall: true } },
    ]);
  });
});

describe("a meeting's cards", () => {
  beforeEach(signIn);

  it('bwat_cards_list reads the cards of one meeting from the card service', async () => {
    routes[`GET /v1/occurrences/${MEETING_ID}/cards`] = [200, [CARD]];
    const result = await call('bwat_cards_list', { meeting_id: MEETING_ID });
    expect(result.structuredContent).toEqual({ cards: [CARD] });
  });
});

describe('signing in and out from the client, with the Desktop client bwat hands out', () => {
  it('bwat_login opens Google sign-in and the sign-in completes in the background', async () => {
    routes['GET /v1/auth/desktop-client'] = [200, { client_id: 'desktop.apps.googleusercontent.com', client_secret: 'desktop-secret' }];
    routes['GET /v1/me'] = [200, ME];
    await connect();
    const started = await call('bwat_login');
    expect(started.isError).toBeFalsy();
    const { sign_in_url } = started.structuredContent as { sign_in_url: string };
    const auth = new URL(sign_in_url);
    expect(auth.searchParams.get('client_id')).toBe('desktop.apps.googleusercontent.com');

    // The browser: Google sends the person back to the plugin's loopback redirect.
    const back = new URL(auth.searchParams.get('redirect_uri')!);
    back.search = new URLSearchParams({ code: 'the-code', state: auth.searchParams.get('state')! }).toString();
    expect((await fetch(back)).status).toBe(200);

    await until(() => store().load() !== undefined);
    expect(store().load()?.email).toBe(ME.email);
    expect((await call('bwat_status')).structuredContent).toMatchObject({ member: ME });
  });

  it('bwat_login twice while one sign-in is waiting answers that same sign-in, not a second one', async () => {
    routes['GET /v1/auth/desktop-client'] = [200, { client_id: 'desktop.apps.googleusercontent.com', client_secret: 'desktop-secret' }];
    await connect();
    const first = (await call('bwat_login')).structuredContent as { sign_in_url: string };
    const second = (await call('bwat_login')).structuredContent as { sign_in_url: string };
    expect(second.sign_in_url).toBe(first.sign_in_url);
  });

  it('bwat_login says so when the install has no Desktop client', async () => {
    routes['GET /v1/auth/desktop-client'] = [200, { client_id: null, client_secret: null }];
    const result = await call('bwat_login');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: 'desktop_client_not_configured', hint: expect.stringMatching(/BWAT_GOOGLE_DESKTOP_CLIENT_ID/) });
  });

  it('bwat_logout forgets the sign-in for this bwat', async () => {
    signIn();
    const result = await call('bwat_logout');
    expect(result.structuredContent).toEqual({ signed_out: true, base_url: baseUrl });
    expect(store().load()).toBeUndefined();
  });

  it('a signed-out tool names /bwat:login', async () => {
    const result = await call('bwat_bot_meetings');
    expect(result.structuredContent).toEqual({ code: 'not_signed_in', hint: expect.stringMatching(/\/bwat:login/) });
  });
});

describe("this session's inbox, switched off and on", () => {
  const puts = () => seen.filter((r) => r.method === 'PUT');
  beforeEach(() => {
    signIn();
    routes[`PUT /v1/sessions/${SESSION}`] = [200, { session_id: SESSION }];
  });

  it('bwat_inbox_off ends the registration; bwat_inbox_on registers again; off survives a restart', async () => {
    await connect('claude-code', { CLAUDE_CODE_SESSION_ID: SESSION });
    await until(() => puts().length === 1);

    expect((await call('bwat_inbox_off')).structuredContent).toEqual({ session_id: SESSION, inbox: 'off' });
    await until(() => puts().length === 2);
    expect(puts()[1]).toMatchObject({ body: { ended: true } });

    // A new server for the same session stays off: nothing is registered.
    await mcp!.close();
    mcp = undefined;
    seen.length = 0;
    await connect('claude-code', { CLAUDE_CODE_SESSION_ID: SESSION });
    await new Promise((r) => setTimeout(r, 300));
    expect(puts()).toEqual([]);

    expect((await call('bwat_inbox_on')).structuredContent).toEqual({ session_id: SESSION, inbox: 'on' });
    await until(() => puts().length === 1);
    expect(puts()[0]).toMatchObject({ body: { ended: false } });
  });

  it('a session id that could leave BWAT_HOME is ignored: no switch, no registration, no files', async () => {
    await connect('claude-code', { CLAUDE_CODE_SESSION_ID: '../../outside-home' });
    const { tools } = await mcp!.listTools();
    expect(tools.map((t) => t.name)).not.toContain('bwat_inbox_off');
    await new Promise((r) => setTimeout(r, 300));
    expect(puts()).toEqual([]);
  });

  it('a client without a session has no inbox switch', async () => {
    const { tools } = await (await connect('generic')).listTools();
    expect(tools.map((t) => t.name)).not.toContain('bwat_inbox_off');
  });
});

// The status line is gone, and with it the only use of a poll that wakes nothing.
it('a session with no messaging socket does not poll its inbox', async () => {
  signIn();
  routes[`PUT /v1/sessions/${SESSION}`] = [200, { session_id: SESSION }];
  const inbox = `/v1/me/inbox?scope=session&client_session=${SESSION}&unread_only=true`;
  routes[`GET ${inbox}`] = [200, { messages: [] }];
  await connect('claude-code', { CLAUDE_CODE_SESSION_ID: SESSION, BWAT_INBOX_POLL_MS: '50' });
  await until(() => seen.some((r) => r.url === `/v1/sessions/${SESSION}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(seen.filter((r) => r.url === inbox)).toEqual([]);
});
