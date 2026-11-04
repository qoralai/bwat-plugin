import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshIdToken, login } from '../../src/auth/google.js';
import { signInPage } from '../../src/auth/signin-page.js';
import { type Credential, credentialStore } from '../../src/auth/store.js';

// In-process: a fake Google token endpoint, and the test plays the browser through the loopback redirect.
const BASE = new URL('https://bwat.example/v1');
const CLIENT = { id: 'desktop-client.apps.googleusercontent.com', secret: 'desktop-secret' };
const AUTH_URL = 'https://accounts.example/auth';

/** Every token any fake handed out, and everything the code under test wrote or threw, across all tests: checked after each. */
const issued: string[] = [];
const output: string[] = [];
const say = (line: string) => void output.push(line);

const jwt = (claims: Record<string, unknown>) => {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const token = `${part({ alg: 'RS256' })}.${part(claims)}.sig-${issued.length}`;
  issued.push(token);
  return token;
};
const refreshToken = () => {
  const token = `1//refresh-${issued.length}`;
  issued.push(token);
  return token;
};

type TokenRequest = Record<string, string>;
let google: Server;
let tokenUrl: string;
let requests: TokenRequest[];
let home: string;
/** Google sends a refresh token only on a member's first consent to this client. */
let firstConsent: boolean;
/** When set, the fake token endpoint answers with this instead of a good token response. */
let misbehave: ((form: TokenRequest) => { status: number; body: string }) | undefined;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'bwat-google-'));
  requests = [];
  firstConsent = true;
  misbehave = undefined;
  google = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(body)) as TokenRequest;
      requests.push(form);
      if (misbehave) {
        const bad = misbehave(form);
        res.writeHead(bad.status, { 'content-type': 'application/json' }).end(bad.body);
        return;
      }
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const answer =
        form.grant_type === 'refresh_token' || !firstConsent
          ? { id_token: jwt({ email: 'member@bwat.example', sub: '42', exp }), expires_in: 3599 }
          : { id_token: jwt({ email: 'member@bwat.example', sub: '42', exp }), refresh_token: refreshToken(), expires_in: 3599 };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => google.listen(0, '127.0.0.1', r));
  tokenUrl = `http://127.0.0.1:${(google.address() as AddressInfo).port}/token`;
});
afterEach(async () => {
  await new Promise((r) => google.close(r));
  rmSync(home, { recursive: true, force: true });
});
afterAll(() => {
  expect(issued.length).toBeGreaterThan(0);
  const all = output.join('\n');
  for (const token of issued) expect(all).not.toContain(token);
});

const store = () => credentialStore(BASE, home);

type Page = { status: number; type: string | null; body: string };

/** The browser: follow Google's consent straight back to the loopback redirect with this code and state. */
function browser(answer: (auth: URL) => Record<string, string>) {
  const seen: URL[] = [];
  /** The page the loopback server showed, once per visit. */
  const pages: Promise<Page | undefined>[] = [];
  const open = (href: string) => {
    const auth = new URL(href);
    seen.push(auth);
    const back = new URL(auth.searchParams.get('redirect_uri')!);
    for (const [k, v] of Object.entries(answer(auth))) back.searchParams.set(k, v);
    pages.push(
      fetch(back)
        .then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), body: await r.text() }))
        .then((page) => (output.push(page.body), page))
        .catch(() => undefined),
    );
  };
  return { open, seen, pages };
}

const signIn = (open: (href: string) => void) =>
  login(store(), { client: CLIENT, authUrl: AUTH_URL, tokenUrl, openBrowser: open, say });

describe('bwat-plugin login', () => {
  it('signs in with PKCE over a loopback redirect and stores the tokens', async () => {
    const b = browser((auth) => ({ code: 'the-code', state: auth.searchParams.get('state')! }));
    const credential = await signIn(b.open);

    const auth = b.seen[0]!;
    expect(auth.origin + auth.pathname).toBe(AUTH_URL);
    expect(auth.searchParams.get('client_id')).toBe(CLIENT.id);
    expect(auth.searchParams.get('response_type')).toBe('code');
    expect(auth.searchParams.get('scope')).toBe('openid email');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(auth.searchParams.get('prompt')).toBe('consent');

    const exchange = requests[0]!;
    expect(exchange).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_id: CLIENT.id,
      client_secret: CLIENT.secret,
      redirect_uri: auth.searchParams.get('redirect_uri'),
    });
    const challenge = createHash('sha256').update(exchange.code_verifier!).digest('base64url');
    expect(auth.searchParams.get('code_challenge')).toBe(challenge);

    const stored = store().load();
    expect(stored).toEqual(credential);
    expect(stored).toMatchObject({
      email: 'member@bwat.example', sub: '42', id_token: issued.at(-2), refresh_token: issued.at(-1),
      client_id: CLIENT.id, client_secret: CLIENT.secret,
    });
    expect(Date.parse(stored!.expires_at)).toBeGreaterThan(Date.now() + 50 * 60_000);

    const page = await b.pages[0];
    expect(page).toMatchObject({ status: 200, type: 'text/html; charset=utf-8' });
    expect(page!.body).toMatch(/^<!doctype html>/);
    expect(page!.body).toContain("<h1>You're signed in</h1>");
  });

  it('keeps the stored refresh token when signing in again returns none', async () => {
    const b = browser((auth) => ({ code: 'the-code', state: auth.searchParams.get('state')! }));
    const first = await signIn(b.open);
    firstConsent = false;
    const again = await signIn(b.open);
    expect(again.id_token).not.toBe(first.id_token);
    expect(store().load()).toMatchObject({ id_token: again.id_token, refresh_token: first.refresh_token });
  });

  it("does not keep another account's refresh token when signing in again returns none", async () => {
    store().save({ email: 'other@bwat.example', sub: '7', id_token: 'other-id', refresh_token: 'other-refresh', expires_at: '2026-10-02T12:00:00.000Z', client_id: CLIENT.id });
    firstConsent = false;
    const b = browser((auth) => ({ code: 'the-code', state: auth.searchParams.get('state')! }));
    await signIn(b.open);
    expect(store().load()?.refresh_token).toBeUndefined();
  });

  it('gives up, and closes its loopback server, when nobody comes back within the time allowed', async () => {
    let redirect = '';
    const pending = login(store(), {
      client: CLIENT, say, tokenUrl, authUrl: AUTH_URL, timeoutMs: 50,
      openBrowser: (href) => void (redirect = new URL(href).searchParams.get('redirect_uri')!),
    });
    await expect(pending).rejects.toThrow(/timed out/);
    await expect(fetch(redirect)).rejects.toThrow();
    expect(store().load()).toBeUndefined();
  });

  it('refuses a redirect whose state is not the one it sent, and stores nothing', async () => {
    const b = browser(() => ({ code: 'the-code', state: 'forged' }));
    const refused = await signIn(b.open).catch((err: Error) => err);
    output.push(String(refused));
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).toMatch(/state/);
    expect(requests).toHaveLength(0);
    expect(store().load()).toBeUndefined();

    const page = await b.pages[0];
    expect(page).toMatchObject({ status: 400, type: 'text/html; charset=utf-8' });
    expect(page!.body).toContain('<h1>Sign-in refused</h1>');
  });
});

describe('the page the browser is left on', () => {
  it('escapes the text it is given', () => {
    const page = signInPage('A <b> & c', 'then <script>alert(1)</script>');
    expect(page).toContain('<h1>A &lt;b&gt; &amp; c</h1>');
    expect(page).toContain('<p>then &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(page).not.toContain('<script>');
  });
});

describe('the ID token in use', () => {
  const stored = (minutesLeft: number): Credential => ({
    email: 'member@bwat.example',
    sub: '42',
    id_token: jwt({ email: 'member@bwat.example', sub: '42' }),
    refresh_token: refreshToken(),
    expires_at: new Date(Date.now() + minutesLeft * 60_000).toISOString(),
    client_id: CLIENT.id,
    client_secret: CLIENT.secret,
  });
  // No client is passed in: the refresh uses the one the member signed in with.
  const fresh = () => freshIdToken(store(), { tokenUrl });

  it('is used as stored while it has more than five minutes left', async () => {
    const credential = stored(10);
    store().save(credential);
    expect(await fresh()).toBe(credential.id_token);
    expect(requests).toHaveLength(0);
  });

  it('is refreshed when within five minutes of expiry, keeping the refresh token', async () => {
    const credential = stored(4);
    store().save(credential);
    const token = await fresh();
    expect(token).not.toBe(credential.id_token);
    expect(requests).toEqual([
      { grant_type: 'refresh_token', refresh_token: credential.refresh_token, client_id: CLIENT.id, client_secret: CLIENT.secret },
    ]);
    expect(store().load()).toMatchObject({ id_token: token, refresh_token: credential.refresh_token, client_id: CLIENT.id, client_secret: CLIENT.secret });
    expect(Date.parse(store().load()!.expires_at)).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it('is refreshed once when two callers find it expiring together', async () => {
    store().save(stored(1));
    const [a, b] = await Promise.all([fresh(), fresh()]);
    expect(a).toBe(b);
    expect(requests).toHaveLength(1);
  });

  it('asks for a new sign-in when it cannot be refreshed, and calls Google for nothing', async () => {
    store().save({ ...stored(1), refresh_token: undefined });
    await expect(fresh()).rejects.toThrow(/bwat-plugin login/);
    expect(requests).toHaveLength(0);
  });

  it('is undefined when nobody has signed in', async () => {
    expect(await fresh()).toBeUndefined();
  });
});

describe('when Google refuses the token request or answers with something unusable', () => {
  const exp = () => Math.floor(Date.now() / 1000) + 3600;
  const payload = (claims: Record<string, unknown>) => Buffer.from(JSON.stringify(claims)).toString('base64url');
  // Each answer is a 200 that the code must not turn into a stored credential.
  const unusable: [string, () => string][] = [
    ['no ID token', () => JSON.stringify({ access_token: 'x', expires_in: 3599 })],
    ['an ID token that is not a string', () => JSON.stringify({ id_token: 42 })],
    ['an ID token whose payload is not JSON', () => JSON.stringify({ id_token: `h.${Buffer.from('{nope').toString('base64url')}.s` })],
    ['an ID token with no payload part', () => JSON.stringify({ id_token: 'just-one-part' })],
    ['an ID token without an email', () => JSON.stringify({ id_token: `h.${payload({ sub: '42', exp: exp() })}.s` })],
    ['an ID token without a subject', () => JSON.stringify({ id_token: `h.${payload({ email: 'member@bwat.example', exp: exp() })}.s` })],
    ['an ID token whose expiry is not a number', () => JSON.stringify({ id_token: `h.${payload({ email: 'member@bwat.example', sub: '42', exp: 'later' })}.s` })],
  ];

  const expiring = (): Credential => ({
    email: 'member@bwat.example',
    sub: '42',
    id_token: jwt({ email: 'member@bwat.example', sub: '42' }),
    refresh_token: refreshToken(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    client_id: CLIENT.id,
    client_secret: CLIENT.secret,
  });
  const refresh = () => freshIdToken(store(), { tokenUrl });

  it('fails a refresh Google refuses with its status only, keeps the stored sign-in, and releases the lock', async () => {
    const before = expiring();
    store().save(before);
    // Google's error body may quote what it was sent: it must never reach the error.
    misbehave = (form) => ({ status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: `revoked ${form.refresh_token}` }) });
    const refused = await refresh().catch((err: Error) => err);
    output.push(String(refused));
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBe('Google refused the token request (HTTP 400)');
    expect(store().load()).toEqual(before);
    // The lock is free again: the next caller gets to try, and succeeds once Google answers.
    misbehave = undefined;
    const token = await refresh();
    expect(token).not.toBe(before.id_token);
    expect(store().load()).toMatchObject({ id_token: token, refresh_token: before.refresh_token });
  });

  it.each(unusable)('fails a refresh answered with %s, and keeps the stored sign-in as it was', async (_label, body) => {
    const before = expiring();
    store().save(before);
    misbehave = () => ({ status: 200, body: body() });
    const refused = await refresh().catch((err: Error) => err);
    output.push(String(refused));
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/^Google sent (no ID token|an unreadable ID token|an ID token without an email, subject or expiry)$/);
    expect(requests).toHaveLength(1);
    expect(store().load()).toEqual(before);
  });

  it.each(unusable)("fails a sign-in answered with %s, and leaves another account's stored sign-in byte for byte", async (_label, body) => {
    // A sign-in that fails must not overwrite whatever is stored: checked on the file, not through
    // load(), which would hide a malformed credential as "not signed in".
    store().save({ ...expiring(), email: 'earlier@bwat.example', sub: '7' });
    const file = join(store().dir, 'google.json');
    const bytes = readFileSync(file, 'utf8');
    misbehave = () => ({ status: 200, body: body() });
    const b = browser((auth) => ({ code: 'the-code', state: auth.searchParams.get('state')! }));
    const refused = await signIn(b.open).catch((err: Error) => err);
    output.push(String(refused));
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/^Google sent (no ID token|an unreadable ID token|an ID token without an email, subject or expiry)$/);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ grant_type: 'authorization_code', code: 'the-code' });
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('fails a sign-in Google refuses with its status only, and stores nothing', async () => {
    misbehave = () => ({ status: 401, body: JSON.stringify({ error: 'invalid_client' }) });
    const b = browser((auth) => ({ code: 'the-code', state: auth.searchParams.get('state')! }));
    const refused = await signIn(b.open).catch((err: Error) => err);
    output.push(String(refused));
    expect((refused as Error).message).toBe('Google refused the token request (HTTP 401)');
    expect(existsSync(join(store().dir, 'google.json'))).toBe(false);
  });
});
