import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createSocketServer, type AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialStore } from '../src/auth/store.js';
import { BUNDLE } from './bundle.js';

// Outside-in: each backend tool through the shipped bundle, against a local HTTP server that
// answers as the bwat backend README documents. The real backend is exercised in Docker
// (test/e2e/docker.e2e.test.ts).

const TOKEN = 'eyJ.id-token-secret.sig';
const MESSAGE_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const MEETING_ID = '0b9e8d7c-6b5a-4f39-8a27-160514f3e2d1';

// The README's JSON blocks, with their placeholders filled in.
const ME = { id: '11111111-2222-4333-8444-555555555555', email: 'dev-person@bwat.invalid', display_name: null, role: 'owner' };
const MESSAGE = {
  id: MESSAGE_ID,
  message_type: 'handoff',
  created_at: '2026-10-02T09:00:00.000Z',
  read_at: null,
  target_client_session: 'sess-0001',
  source: { kind: 'card', id: '22222222-3333-4444-8555-666666666666' },
  handoff_id: '33333333-4444-4555-8666-777777777777',
  subject: 'Follow up on the launch',
};
const MEETINGS = {
  meetings: [
    {
      id: MEETING_ID, occurrence_id: 'mtg/Occ+1==', title: 'Board offsite',
      started_at: '2026-10-01T15:00:00.000Z', ended_at: '2026-10-01T15:30:00.000Z', duration_seconds: 1800,
      attendee_count: 4, transcript_available: true, finalization: 'transcript_complete',
    },
  ],
  next_cursor: null,
};
const TRANSCRIPT = {
  meeting_id: MEETING_ID,
  occurrence_id: 'mtg/Occ+1==',
  finalization: 'transcript_complete',
  complete: true,
  occurrence_state: 'ended',
  segments: [
    { epoch: 1, seq: 0, speaker: { label: 'Speaker 1', member_id: null }, text: 'hello', start_ms: 0, end_ms: 4200, source: 'asr' },
  ],
  next_cursor: null,
};

type Reply = [number, unknown?];
let routes: Record<string, Reply>;
/** A route's answer waits for its promise: to hold one request open while a test acts. */
let held: Record<string, Promise<void>>;
let seen: { method?: string; url?: string; authorization?: string; body?: unknown }[];
let server: Server;
let baseUrl: string;
let home: string;
let mcp: Client | undefined;

beforeEach(async () => {
  seen = [];
  routes = {};
  held = {};
  server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: text ? JSON.parse(text) : undefined });
      const key = `${req.method} ${req.url}`;
      const [status, body] = routes[key] ?? [404, { error: 'not_found' }];
      void (held[key] ?? Promise.resolve()).then(() => {
        if (body === undefined) res.writeHead(status).end();
        else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  home = mkdtempSync(join(tmpdir(), 'bwat-home-'));
});

afterEach(async () => {
  // The client first: it ends the server process, which holds a keep-alive socket to ours.
  await mcp?.close();
  mcp = undefined;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

function signIn() {
  credentialStore(new URL(baseUrl), home).save({
    email: ME.email, sub: 'sub-1', id_token: TOKEN, client_id: 'unused', expires_at: '2099-01-01T00:00:00.000Z',
  });
}

async function connect(env: Record<string, string> = { BWAT_BASE_URL: baseUrl }, client = 'generic'): Promise<Client> {
  mcp = new Client({ name: 'acceptance', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE, 'serve', '--client', client],
      // Never this test run's own Claude Code session or socket, when it runs inside one.
      env: { ...(process.env as Record<string, string>), BWAT_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), CLAUDE_CODE_SESSION_ID: '', CLAUDE_CODE_MESSAGING_SOCKET: '', ...env },
      // Never this repository's own checkout either: a session's keywords come from its folder.
      cwd: home,
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

describe('signed in, the tools read the backend with the stored token', () => {
  beforeEach(signIn);

  it('bwat_status answers who is signed in and to which backend', async () => {
    routes['GET /v1/me'] = [200, ME];
    const result = await call('bwat_status');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ adapter: 'generic', version: expect.any(String), base_url: baseUrl, member: ME });
    expect(seen).toEqual([{ method: 'GET', url: '/v1/me', authorization: `Bearer ${TOKEN}` }]);
  });

  it('bwat_inbox_list asks for unread messages across all sessions by default', async () => {
    routes['GET /v1/me/inbox?scope=all&unread_only=true'] = [200, { messages: [MESSAGE], next_cursor: 'n1' }];
    const result = await call('bwat_inbox_list');
    expect(result.structuredContent).toEqual({ messages: [MESSAGE], next_cursor: 'n1' });
  });

  it('bwat_inbox_list narrows to one session, includes read ones on request, and pages', async () => {
    routes['GET /v1/me/inbox?scope=session&client_session=sess-0001&unread_only=false&cursor=n1'] = [200, { messages: [] }];
    const result = await call('bwat_inbox_list', { session_id: 'sess-0001', unread_only: false, cursor: 'n1' });
    expect(result.structuredContent).toEqual({ messages: [] });
  });

  it('bwat_inbox_get reads one message, body included', async () => {
    const full = { ...MESSAGE, body: 'Draft the launch note.' };
    routes[`GET /v1/me/inbox/${MESSAGE_ID}`] = [200, full];
    expect((await call('bwat_inbox_get', { message_id: MESSAGE_ID })).structuredContent).toEqual(full);
  });

  it('bwat_inbox_mark_read marks that one message read', async () => {
    const read = { id: MESSAGE_ID, read_at: '2026-10-02T10:00:00.000Z' };
    routes[`PATCH /v1/me/inbox/${MESSAGE_ID}`] = [200, read];
    expect((await call('bwat_inbox_mark_read', { message_id: MESSAGE_ID })).structuredContent).toEqual(read);
    expect(seen.map((r) => r.method)).toEqual(['PATCH']);
  });

  it('bwat_meetings_list lists the history and pages', async () => {
    routes['GET /v1/meetings'] = [200, MEETINGS];
    routes['GET /v1/meetings?cursor=m2'] = [200, { meetings: [], next_cursor: null }];
    expect((await call('bwat_meetings_list')).structuredContent).toEqual(MEETINGS);
    expect((await call('bwat_meetings_list', { cursor: 'm2' })).structuredContent).toEqual({ meetings: [], next_cursor: null });
  });

  it('bwat_transcript_get reads by Zoom occurrence, URL-encoded, and pages', async () => {
    routes['GET /v1/meetings/mtg%2FOcc%2B1%3D%3D/transcript?cursor=t2'] = [200, TRANSCRIPT];
    const result = await call('bwat_transcript_get', { occurrence_id: 'mtg/Occ+1==', cursor: 't2' });
    expect(result.structuredContent).toEqual(TRANSCRIPT);
  });

  // A live meeting's page of 200 lines is too long for one tool result.
  it('bwat_transcript_get reads a smaller page, or only the newest lines', async () => {
    routes[`GET /v1/meetings/${MEETING_ID}/transcript?cursor=t2&limit=50`] = [200, TRANSCRIPT];
    routes[`GET /v1/meetings/${MEETING_ID}/transcript?tail=30`] = [200, TRANSCRIPT];
    expect((await call('bwat_transcript_get', { occurrence_id: MEETING_ID, cursor: 't2', limit: 50 })).structuredContent).toEqual(TRANSCRIPT);
    expect((await call('bwat_transcript_get', { occurrence_id: MEETING_ID, tail: 30 })).structuredContent).toEqual(TRANSCRIPT);
  });

  it.each([
    ['not_found', 404, 'bwat_inbox_get', { message_id: MESSAGE_ID }, /no such/i],
    ['not_onboarded', 403, 'bwat_meetings_list', {}, /owner/i],
    ['unauthorized', 401, 'bwat_meetings_list', {}, /\/bwat:login/],
    ['invalid_query', 400, 'bwat_transcript_get', { occurrence_id: MEETING_ID, cursor: 'forged' }, /cursor/i],
  ])('the backend\'s %s is a tool error with a hint', async (code, status, name, args, hint) => {
    routes['GET /v1/me'] = [status, { error: code }];
    routes[`GET /v1/me/inbox/${MESSAGE_ID}`] = [status, { error: code }];
    routes['GET /v1/meetings'] = [status, { error: code }];
    routes[`GET /v1/meetings/${MEETING_ID}/transcript?cursor=forged`] = [status, { error: code }];
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code, hint: expect.stringMatching(hint) });
  });

  it('a backend that does not answer is a tool error, not a crash', async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    server = createServer();
    const result = await call('bwat_meetings_list');
    expect(result.structuredContent).toMatchObject({ code: 'backend_unavailable' });
  });

  it.each([
    ['bwat_inbox_get', 'not-a-uuid'],
    ['bwat_inbox_mark_read', '../../meetings'],
  ])('%s refuses a message id that is not a UUID before sending anything', async (name, id) => {
    const result = await call(name, { message_id: id });
    expect(result.structuredContent).toMatchObject({ code: 'invalid_arguments' });
    expect(seen).toEqual([]);
  });
});

describe('without a usable sign-in or backend', () => {
  it('bwat_status still answers signed out, with no member and the reason', async () => {
    const result = await call('bwat_status');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      adapter: 'generic', version: expect.any(String), base_url: baseUrl,
      member: null, member_error: 'not_signed_in', member_hint: expect.stringMatching(/\/bwat:login/),
    });
    expect(seen).toEqual([]);
  });

  it('bwat_status still answers when the backend refuses the sign-in', async () => {
    signIn();
    routes['GET /v1/me'] = [401, { error: 'unauthorized' }];
    const result = await call('bwat_status');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ base_url: baseUrl, member: null, member_error: 'unauthorized' });
  });

  it('bwat_status still answers with no BWAT_BASE_URL', async () => {
    await connect({ BWAT_BASE_URL: '' });
    const result = await call('bwat_status');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      adapter: 'generic', version: expect.any(String), base_url: null,
      member: null, member_error: 'backend_not_configured', member_hint: expect.stringMatching(/BWAT_BASE_URL/),
    });
  });

  it('a sign-in that expired and cannot be renewed: status still answers, tools say so, nothing is sent', async () => {
    credentialStore(new URL(baseUrl), home).save({
      email: ME.email, sub: 'sub-1', id_token: TOKEN, client_id: 'unused', expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect((await call('bwat_status')).structuredContent).toMatchObject({
      base_url: baseUrl, member: null, member_error: 'sign_in_expired', member_hint: expect.stringMatching(/\/bwat:login/),
    });
    const result = await call('bwat_meetings_list');
    expect(result.structuredContent).toEqual({ code: 'sign_in_expired', hint: expect.stringMatching(/\/bwat:login/) });
    expect(seen).toEqual([]);
  });

  it('not signed in: no request is sent, and the hint names the sign-in command', async () => {
    const result = await call('bwat_inbox_list');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: 'not_signed_in', hint: expect.stringMatching(/\/bwat:login/) });
    expect(seen).toEqual([]);
  });

  it('no BWAT_BASE_URL: the backend tools say so', async () => {
    await connect({ BWAT_BASE_URL: '' });
    const result = await call('bwat_meetings_list');
    expect(result.structuredContent).toEqual({ code: 'backend_not_configured', hint: expect.stringMatching(/BWAT_BASE_URL/) });
  });
});

describe('an address saved by bwat_login, for a client that cannot set BWAT_BASE_URL (Codex)', () => {
  const DESKTOP = [200, { client_id: 'desktop.apps.googleusercontent.com', client_secret: 'desktop-secret' }] as Reply;
  // The kept file is the address, then a tag new with every save.
  const saved = () => (existsSync(join(home, 'base_url')) ? readFileSync(join(home, 'base_url'), 'utf8').split('\n')[0] : undefined);
  const unset = { BWAT_BASE_URL: '', BWAT_NO_BROWSER: '1' };

  it('with no address, the hint tells the model to ask the user and pass it to bwat_login', async () => {
    await connect(unset, 'codex');
    const result = await call('bwat_meetings_list');
    expect(result.structuredContent).toEqual({ code: 'backend_not_configured', hint: expect.stringMatching(/ask the user.*bwat_login.*base_url/i) });
  });

  it('bwat_login with base_url keeps the address, the tools use it at once, and the next server too', async () => {
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    await connect(unset, 'codex');
    const started = await call('bwat_login', { base_url: baseUrl });
    expect(started.isError).toBeFalsy();
    expect(saved()).toBe(baseUrl);

    signIn();
    routes['GET /v1/meetings'] = [200, MEETINGS];
    expect((await call('bwat_meetings_list')).structuredContent).toEqual(MEETINGS);
    expect(seen.at(-1)).toEqual({ method: 'GET', url: '/v1/meetings', authorization: `Bearer ${TOKEN}` });

    await mcp!.close();
    await connect(unset, 'codex');
    expect((await call('bwat_status')).structuredContent).toMatchObject({ base_url: baseUrl });
  });

  it('the board address alone means its API, under /v1', async () => {
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    await connect(unset, 'codex');
    expect((await call('bwat_login', { base_url: baseUrl.replace(/\/v1$/, '') })).isError).toBeFalsy();
    expect(saved()).toBe(baseUrl);
  });

  it('the kept address spelled with a trailing slash is the same address, not another', async () => {
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    writeFileSync(join(home, 'base_url'), `${baseUrl}\n`);
    await connect(unset, 'codex');
    expect((await call('bwat_login', { base_url: `${baseUrl}/` })).isError).toBeFalsy();
    expect(saved()).toBe(baseUrl);
  });

  it('a kept address is not replaced by another bwat_login', async () => {
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    await connect(unset, 'codex');
    await call('bwat_login', { base_url: baseUrl });
    const refused = await call('bwat_login', { base_url: 'https://bwat.example' });
    expect(refused.structuredContent).toEqual({ code: 'base_url_already_set', hint: expect.stringMatching(/\/bwat:logout/) });
    expect(saved()).toBe(baseUrl);
  });

  it('after bwat_logout another address can be set, and the old sign-in is never sent to it', async () => {
    const other = baseUrl.replace(/\/v1$/, '/other/v1');
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    routes['GET /other/v1/auth/desktop-client'] = DESKTOP;
    // Kept and signed in earlier: no sign-in is still open.
    writeFileSync(join(home, 'base_url'), `${baseUrl}\n`);
    await connect(unset, 'codex');
    expect((await call('bwat_logout')).structuredContent).toEqual({ signed_out: true, base_url: baseUrl, address_forgotten: true });
    expect(saved()).toBeUndefined();
    signIn();
    expect((await call('bwat_login', { base_url: other })).isError).toBeFalsy();
    expect(saved()).toBe(other);
    seen = [];
    expect((await call('bwat_meetings_list')).structuredContent).toMatchObject({ code: 'not_signed_in' });
    expect(seen.filter((r) => r.url?.startsWith('/other/'))).toEqual([]);
    expect(seen.some((r) => r.authorization)).toBe(false);
  });

  it.each([
    ['not https', 'http://bwat.example', /must use https/],
    ['not a URL', 'bwat.example', /not a URL/],
    ['credentials in it', 'https://user:pw@bwat.example', /credentials/],
  ])('an address that is %s is refused and not kept', async (_label, value, reason) => {
    await connect(unset, 'codex');
    const result = await call('bwat_login', { base_url: value });
    expect(result.structuredContent).toEqual({ code: 'invalid_base_url', hint: expect.stringMatching(reason) });
    expect(saved()).toBeUndefined();
  });

  it('while a sign-in to one bwat is open, one to another is refused, not answered with the first link', async () => {
    const other = baseUrl.replace(/\/v1$/, '/other/v1');
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    routes['GET /other/v1/auth/desktop-client'] = DESKTOP;
    await connect(unset, 'codex');
    await call('bwat_login', { base_url: baseUrl });
    await call('bwat_logout');
    const result = await call('bwat_login', { base_url: other });
    expect(result.structuredContent).toEqual({ code: 'sign_in_failed', hint: expect.stringMatching(/another bwat is still open/) });
    expect(saved()).toBeUndefined();
  });

  it('two bwat_login calls at once with different addresses: one is kept, the other refused', async () => {
    const other = baseUrl.replace(/\/v1$/, '/other/v1');
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    routes['GET /other/v1/auth/desktop-client'] = DESKTOP;
    await connect(unset, 'codex');
    const results = await Promise.all([call('bwat_login', { base_url: baseUrl }), call('bwat_login', { base_url: other })]);
    const codes = results.map((r) => (r.structuredContent as { code?: string }).code);
    expect(codes.sort()).toEqual(['base_url_already_set', undefined].sort());
    const winner = results.findIndex((r) => !r.isError);
    expect(saved()).toBe([baseUrl, other][winner]);
  });

  it('an address that cannot be kept starts no sign-in', async () => {
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    // BWAT_HOME is a file, not a directory: the save fails.
    writeFileSync(join(home, 'not-a-dir'), '');
    await connect({ ...unset, BWAT_HOME: join(home, 'not-a-dir') }, 'codex');
    const result = await call('bwat_login', { base_url: baseUrl });
    expect(result.structuredContent).toEqual({ code: 'sign_in_failed', hint: expect.stringMatching(/could not start/) });
    expect((await call('bwat_status')).structuredContent).toMatchObject({ base_url: null });
  });

  it('an address that answers without a way to sign in is not kept', async () => {
    routes['GET /v1/auth/desktop-client'] = [200, { client_id: null }];
    await connect(unset, 'codex');
    expect((await call('bwat_login', { base_url: baseUrl })).structuredContent).toMatchObject({ code: 'desktop_client_not_configured' });
    expect(saved()).toBeUndefined();
  });

  it('with the Google client set in the environment, a new address is still asked before it is kept', async () => {
    await connect({ ...unset, BWAT_GOOGLE_CLIENT_ID: 'env.apps.googleusercontent.com' }, 'codex');
    const result = await call('bwat_login', { base_url: baseUrl.replace(/\/v1$/, '/nothing/v1') });
    expect(result.structuredContent).toMatchObject({ code: 'backend_unavailable' });
    expect(saved()).toBeUndefined();
  });

  it('with the Google client set in the environment, a new address signs in with its own client, not that one', async () => {
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    await connect({ ...unset, BWAT_GOOGLE_CLIENT_ID: 'env.apps.googleusercontent.com' }, 'codex');
    const result = await call('bwat_login', { base_url: baseUrl });
    const url = new URL((result.structuredContent as { sign_in_url: string }).sign_in_url);
    expect(url.searchParams.get('client_id')).toBe('desktop.apps.googleusercontent.com');
  });

  it.each([
    ['without base_url', {}],
    ['with the same base_url', 'same'],
  ])('with the Google client set in the environment, a kept address signing in again, %s, still uses its own client', async (_name, args) => {
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    writeFileSync(join(home, 'base_url'), `${baseUrl}\ntag\n`);
    await connect({ ...unset, BWAT_GOOGLE_CLIENT_ID: 'env.apps.googleusercontent.com' }, 'codex');
    const result = await call('bwat_login', args === 'same' ? { base_url: baseUrl } : args);
    const url = new URL((result.structuredContent as { sign_in_url: string }).sign_in_url);
    expect(url.searchParams.get('client_id')).toBe('desktop.apps.googleusercontent.com');
  });

  it.each([
    ['a kept address signs in with its own client', false, 'desktop.apps.googleusercontent.com'],
    ['BWAT_BASE_URL signs in with the environment one', true, 'env.apps.googleusercontent.com'],
  ])('the login command, with the Google client set in the environment: %s', async (_name, fromEnv, clientId) => {
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    writeFileSync(join(home, 'base_url'), `${baseUrl}\ntag\n`);
    const child = spawn(process.execPath, [BUNDLE, 'login'], {
      env: { ...(process.env as Record<string, string>), BWAT_HOME: home, ...unset, BWAT_BASE_URL: fromEnv ? baseUrl : '', BWAT_GOOGLE_CLIENT_ID: 'env.apps.googleusercontent.com' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    // The login waits for the browser; the address it prints is all this needs.
    const printed = await new Promise<string>((resolve) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        const found = /https:\/\/accounts\.google\.com\S+/.exec(stderr);
        if (found) resolve(found[0]);
      });
    });
    child.kill();
    expect(new URL(printed).searchParams.get('client_id')).toBe(clientId);
  });

  it('with the Google client set in the environment, an address that offers no way to sign in is not kept', async () => {
    routes['GET /v1/auth/desktop-client'] = [200, { client_id: null }];
    await connect({ ...unset, BWAT_GOOGLE_CLIENT_ID: 'env.apps.googleusercontent.com' }, 'codex');
    expect((await call('bwat_login', { base_url: baseUrl })).structuredContent).toMatchObject({ code: 'desktop_client_not_configured' });
    expect(saved()).toBeUndefined();
  });

  it('an address that does not answer as bwat is not kept', async () => {
    await connect(unset, 'codex');
    const result = await call('bwat_login', { base_url: baseUrl.replace(/\/v1$/, '/nothing/v1') });
    expect(result.structuredContent).toMatchObject({ code: 'backend_unavailable' });
    expect(saved()).toBeUndefined();
  });

  it('where the client sets BWAT_BASE_URL, another address is refused; the same one signs in', async () => {
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    await connect({ BWAT_BASE_URL: baseUrl, BWAT_NO_BROWSER: '1' });
    const refused = await call('bwat_login', { base_url: 'https://bwat.example' });
    expect(refused.structuredContent).toEqual({ code: 'base_url_set_by_client', hint: expect.stringContaining(baseUrl) });
    expect((await call('bwat_login', { base_url: baseUrl })).isError).toBeFalsy();
    expect(saved()).toBeUndefined();
  });

  it('BWAT_BASE_URL wins over a saved address', async () => {
    const other = baseUrl.replace(/\/v1$/, '/other/v1');
    writeFileSync(join(home, 'base_url'), `${other}\n`);
    await connect();
    expect((await call('bwat_status')).structuredContent).toMatchObject({ base_url: baseUrl });
  });

  it('a saved address that is no longer usable counts as none', async () => {
    writeFileSync(join(home, 'base_url'), 'http://bwat.example/v1\n');
    await connect(unset, 'codex');
    expect((await call('bwat_status')).structuredContent).toMatchObject({ base_url: null, member_error: 'backend_not_configured' });
  });

  it.each([
    ['another address', '/other/v1'],
    ['the same address again', '/v1'],
  ])('a slow bwat_logout never undoes a sign-in kept while it waited: %s', async (_label, path) => {
    const next = baseUrl.replace(/\/v1$/, path);
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
    };
    writeFileSync(join(home, 'base_url'), `${baseUrl}\nfirst-tag\n`);
    credentialStore(new URL(baseUrl), home).save({
      email: ME.email, sub: 'sub-1', id_token: TOKEN, refresh_token: 'code-refresh', client_id: 'bwat-code', expires_at: '2099-01-01T00:00:00.000Z',
    });
    let release!: () => void;
    held['POST /v1/code-signin/sign-out'] = new Promise((r) => (release = r));
    routes['POST /v1/code-signin/sign-out'] = [204];
    await connect(unset, 'codex');
    const loggingOut = call('bwat_logout');
    await until(() => seen.some((r) => r.url === '/v1/code-signin/sign-out'));
    // Meanwhile another thread logs out too and signs in again: a new record and a new credential.
    const record = `${next}\nsecond-tag\n`;
    writeFileSync(join(home, 'base_url'), record);
    credentialStore(new URL(next), home).save({
      email: ME.email, sub: 'sub-1', id_token: 'eyJ.new-token.sig', client_id: 'unused', expires_at: '2099-01-01T00:00:00.000Z',
    });
    release();
    await loggingOut;
    expect(readFileSync(join(home, 'base_url'), 'utf8')).toBe(record);
    expect(credentialStore(new URL(next), home).load()?.id_token).toBe('eyJ.new-token.sig');
  });

  it('a kept address that is no longer usable: bwat_logout clears it, and a new one can be set', async () => {
    routes['GET /v1/auth/desktop-client'] = DESKTOP;
    writeFileSync(join(home, 'base_url'), 'not an address\n');
    await connect(unset, 'codex');
    expect((await call('bwat_login', { base_url: baseUrl })).structuredContent).toMatchObject({ code: 'base_url_already_set' });
    expect((await call('bwat_logout')).structuredContent).toEqual({ signed_out: true, base_url: null, address_forgotten: true });
    expect((await call('bwat_login', { base_url: baseUrl })).isError).toBeFalsy();
    expect(saved()).toBe(baseUrl);
  });
});

it('serve exits once its client goes away, after it has talked to the backend', async () => {
  signIn();
  routes['GET /v1/me'] = [200, ME];
  const child = spawn(process.execPath, [BUNDLE, 'serve'], {
    env: { ...process.env, BWAT_HOME: home, BWAT_BASE_URL: baseUrl },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = new Promise<number | null>((r) => child.once('exit', r));
  const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const answered = new Promise<void>((r) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('"id":2')) r();
    });
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bwat_status', arguments: {} } });
  await answered;
  expect(seen).toHaveLength(1);
  child.stdin.end();
  const timer = new Promise<'hung'>((r) => setTimeout(() => r('hung'), 3000).unref());
  const outcome = await Promise.race([exited, timer]);
  if (outcome === 'hung') child.kill();
  expect(outcome).toBe(0);
});

describe('session registration: bwat can offer this session as a hand-off target', () => {
  const SESSION = '5b0e7c1a-2f4d-4e8b-9a31-c6d7e8f90a1b';
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
  };
  const puts = () => seen.filter((r) => r.method === 'PUT');
  const descriptor = (kind: string) => ({
    kind, wake: 'pull', machine: hostname(), platform: process.platform, plugin_version: expect.any(String), cwd: expect.any(String),
  });

  beforeEach(signIn);

  it('registers the Claude session name, not another conversation in the same folder', async () => {
    const dir = join(home, 'claude', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '101.json'), JSON.stringify({ pid: 101, sessionId: 'another-session', name: 'Wrong conversation' }));
    writeFileSync(join(dir, '102.json'), JSON.stringify({ pid: 102, sessionId: SESSION, name: 'Zoom invite reliability' }));
    routes[`PUT /v1/sessions/${SESSION}`] = [200, { session_id: SESSION }];
    await connect({ BWAT_BASE_URL: baseUrl, CLAUDE_CODE_SESSION_ID: SESSION }, 'claude-code');
    await until(() => puts().length === 1);
    expect(puts()[0]!.body).toMatchObject({ client: { name: 'Zoom invite reliability' } });
  });

  it('sends the keywords of a Claude session: its checkout, name, edited files and typed prompts', async () => {
    const checkout = join(home, 'work', 'bwat-plugin');
    mkdirSync(join(checkout, '.git'), { recursive: true });
    mkdirSync(join(checkout, 'src', 'mcp'), { recursive: true });
    writeFileSync(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/feature/ABC-4844-session-keywords\n');
    const sessions = join(home, 'claude', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, '102.json'), JSON.stringify({ pid: 102, sessionId: SESSION, name: 'Zoom invite reliability' }));
    const project = join(home, 'claude', 'projects', 'J--work-bwat-plugin');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${SESSION}.jsonl`), [
      { type: 'user', message: { content: 'retry the heartbeat' }, isMeta: false, origin: { kind: 'human' }, promptSource: 'typed', sessionId: SESSION },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: join(checkout, 'src', 'mcp', 'beat.ts'), content: '' } }] }, cwd: checkout, sessionId: SESSION },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    routes[`PUT /v1/sessions/${SESSION}`] = [200, { session_id: SESSION }];
    await connect({ BWAT_BASE_URL: baseUrl, CLAUDE_CODE_SESSION_ID: SESSION }, 'claude-code');
    await until(() => puts().length === 1);
    expect(puts()[0]!.body).toMatchObject({ client: {
      keywords: ['bwat-plugin', 'abc-4844', 'session', 'keywords', 'zoom', 'invite', 'reliability', 'src', 'mcp', 'beat', 'heartbeat', 'retry'],
    } });
  });

  it('registers Codex names and propagates a rename on the next bind', async () => {
    const dir = join(home, 'codex');
    mkdirSync(dir, { recursive: true });
    const index = join(dir, 'session_index.jsonl');
    writeFileSync(index, JSON.stringify({ id: SESSION, thread_name: 'Release notes' }) + '\n');
    routes[`PUT /v1/sessions/${SESSION}`] = [200, { session_id: SESSION }];
    await connect(undefined, 'codex');
    await call('bwat_session_bind', { session_id: SESSION, event: 'prompt' });
    expect(puts()[0]!.body).toMatchObject({ client: { name: 'Release notes' } });
    writeFileSync(index, JSON.stringify({ id: SESSION, thread_name: 'Release notes review' }) + '\n', { flag: 'a' });
    await call('bwat_session_bind', { session_id: SESSION, event: 'stop' });
    expect(puts()[1]!.body).toMatchObject({ client: { name: 'Release notes review' } });
  });

  it('a Claude Code session registers its id at start and ends it when the client goes away', async () => {
    routes[`PUT /v1/sessions/${SESSION}`] = [200, { session_id: SESSION }];
    await connect({ BWAT_BASE_URL: baseUrl, CLAUDE_CODE_SESSION_ID: SESSION }, 'claude-code');
    await until(() => puts().length === 1);
    expect(puts()).toEqual([
      {
        method: 'PUT', url: `/v1/sessions/${SESSION}`, authorization: `Bearer ${TOKEN}`,
        body: { client: descriptor('claude-code'), instance_id: expect.any(String), ended: false },
      },
    ]);
    await mcp?.close();
    mcp = undefined;
    await until(() => puts().length === 2);
    expect(puts()[1]).toMatchObject({ url: `/v1/sessions/${SESSION}`, body: { ended: true, instance_id: (puts()[0]!.body as { instance_id: string }).instance_id } });
  });

  it('a Codex thread registers when its hook binds it, and the tool answers the session id', async () => {
    routes['PUT /v1/sessions/codex-thread-0001'] = [200, { session_id: 'codex-thread-0001' }];
    await connect(undefined, 'codex');
    const result = await call('bwat_session_bind', { session_id: 'codex-thread-0001', event: 'prompt' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ session_id: 'codex-thread-0001' });
    expect(puts()).toEqual([
      {
        method: 'PUT', url: '/v1/sessions/codex-thread-0001', authorization: `Bearer ${TOKEN}`,
        body: { client: descriptor('codex'), instance_id: expect.any(String), ended: false },
      },
    ]);
  });

  it('a generic MCP client does not register', async () => {
    routes['GET /v1/me'] = [200, ME];
    await connect({ BWAT_BASE_URL: baseUrl, CLAUDE_CODE_SESSION_ID: SESSION });
    await call('bwat_status');
    expect(puts()).toEqual([]);
  });

  describe('with Claude Code\'s messaging socket, a queued hand-off wakes the session', () => {
    const SOCKET =
      process.platform === 'win32' ? `\\\\.\\pipe\\bwat-test-${process.pid}-${Date.now()}` : join(tmpdir(), `bwat-test-${process.pid}-${Date.now()}.sock`);
    const INBOX = `GET /v1/me/inbox?scope=session&client_session=${SESSION}&unread_only=true`;
    let lines: Record<string, unknown>[];
    let socket: ReturnType<typeof createSocketServer>;
    const claude = () =>
      connect(
        { BWAT_BASE_URL: baseUrl, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CODE_MESSAGING_SOCKET: SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: 'socket-token' },
        'claude-code',
      );

    beforeEach(async () => {
      lines = [];
      socket = createSocketServer((conn) => {
        let text = '';
        conn.on('data', (d) => (text += d));
        conn.on('end', () => lines.push(...text.split('\n').filter(Boolean).map((l) => JSON.parse(l))));
      });
      await new Promise<void>((r) => socket.listen(SOCKET, r));
      routes[`PUT /v1/sessions/${SESSION}`] = [200, { session_id: SESSION }];
      routes[INBOX] = [200, { messages: [MESSAGE] }];
    });
    afterEach(() => new Promise<void>((r) => socket.close(() => r())));

    it('registers as wake push and writes the auth line, then one line naming the message id only', async () => {
      await claude();
      // Registering and waking start together, so the wake lines can land before the PUT does.
      await until(() => lines.length === 2 && puts().length === 1);
      expect(puts()[0]!.body).toMatchObject({ client: { kind: 'claude-code', wake: 'push' } });
      expect(lines[0]).toEqual({ type: 'auth', token: 'socket-token' });
      expect(lines[1]).toMatchObject({ type: 'user', session_id: SESSION, message: { role: 'user', content: expect.stringContaining(MESSAGE_ID) } });
      expect(JSON.stringify(lines[1])).not.toContain(MESSAGE.subject);
    });

    it('does not wake the session again for the same message after a restart', async () => {
      await claude();
      await until(() => lines.length === 2);
      await mcp?.close();
      mcp = undefined;
      const polls = seen.filter((r) => `${r.method} ${r.url}` === INBOX).length;
      await claude();
      await until(() => seen.filter((r) => `${r.method} ${r.url}` === INBOX).length > polls);
      await new Promise((r) => setTimeout(r, 200));
      expect(lines).toHaveLength(2);
    });
  });
});
