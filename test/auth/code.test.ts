import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODE_CLIENT, codeLogin, signOutCode } from '../../src/auth/code.js';
import { freshIdToken } from '../../src/auth/google.js';
import { credentialStore } from '../../src/auth/store.js';
import { signInMethod } from '../../src/mcp/login.js';

// A fake single-computer bwat: POST /v1/code-signin, /refresh and /sign-out. The test
// plays the browser on the plugin's one-shot sign-in page.
const CODE = 'ABCD-EFGH';
let bwat: Server;
let base: URL;
let home: string;
let seen: { path: string; body: Record<string, unknown> }[];
let expiresIn: number;
let codeSignin: boolean;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'bwat-code-'));
  seen = [];
  expiresIn = 12 * 3600_000;
  codeSignin = true;
  bwat = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ path: req.url ?? '', body });
      const send = (status: number, value?: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(value === undefined ? '' : JSON.stringify(value));
      const expires_at = new Date(Date.now() + expiresIn).toISOString();
      if (req.url === '/v1/auth/desktop-client') return send(200, { client_id: null, client_secret: null, code_signin: codeSignin });
      if (req.url === '/v1/code-signin') {
        if (body.code !== CODE) return send(401, { error: 'wrong_code' });
        return send(200, { token: 'bwz_first', refresh_token: 'bwr_one', expires_at, member: { id: 'member-1', email: String(body.email).toLowerCase() } });
      }
      if (req.url === '/v1/code-signin/refresh') return body.refresh_token === 'bwr_one' ? send(200, { token: 'bwz_next', expires_at }) : send(401, { error: 'signed_out' });
      if (req.url === '/v1/code-signin/sign-out') return send(204);
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((r) => bwat.listen(0, '127.0.0.1', r));
  base = new URL(`http://127.0.0.1:${(bwat.address() as AddressInfo).port}/v1`);
});
afterEach(async () => {
  await new Promise<void>((r) => bwat.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

/** Signs in through the page as a person would: opens it, then submits each try in turn. */
async function signIn(tries: { code: string; email: string }[]) {
  const store = credentialStore(base, home);
  const pages: string[] = [];
  let opened: Promise<void> = Promise.resolve();
  const signedIn = codeLogin(store, {
    baseUrl: base,
    say: () => undefined,
    openBrowser: (url) => {
      opened = (async () => {
        pages.push(await (await fetch(url)).text());
        for (const t of tries) {
          const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(t).toString() });
          pages.push(await res.text());
        }
      })();
    },
    timeoutMs: 5000,
  });
  const credential = await signedIn;
  await opened;
  return { credential, pages, store };
}

describe('signing in to a bwat with no Google, with its code', () => {
  it('reads the install as a code install', async () => {
    expect(await signInMethod(base)).toEqual({ kind: 'code' });
    codeSignin = false;
    expect(await signInMethod(base)).toBeUndefined();
  });

  it('takes the code and email on a page on this computer, and stores the board token and refresh token', async () => {
    const { credential, pages, store } = await signIn([{ code: CODE, email: 'Me@Home.Example' }]);
    expect(pages[0]).toContain('Install code');
    expect(pages[0]).toContain('Anyone with the code can sign in, as any email.');
    expect(pages[1]).toContain("You're signed in");
    expect(credential).toMatchObject({ email: 'me@home.example', sub: 'member-1', id_token: 'bwz_first', refresh_token: 'bwr_one', client_id: CODE_CLIENT });
    expect(store.load()).toMatchObject({ id_token: 'bwz_first', client_id: CODE_CLIENT });
    // The code went to the backend only, and is nowhere in what was stored.
    expect(seen.filter((r) => r.path === '/v1/code-signin').map((r) => r.body)).toEqual([{ code: CODE, email: 'Me@Home.Example' }]);
    expect(readFileSync(join(store.dir, 'google.json'), 'utf8')).not.toContain(CODE);
  });

  it('says a wrong code is wrong and lets the person try again on the same page', async () => {
    const { pages, credential } = await signIn([
      { code: 'WRONG', email: 'me@home.example' },
      { code: CODE, email: 'me@home.example' },
    ]);
    expect(pages[1]).toContain("That code didn't work.");
    expect(pages[2]).toContain("You're signed in");
    expect(credential.id_token).toBe('bwz_first');
  });

  it('refuses a submission that does not carry the page\'s own state', async () => {
    const store = credentialStore(base, home);
    let url = '';
    const signedIn = codeLogin(store, { baseUrl: base, say: () => undefined, openBrowser: (u) => (url = u), timeoutMs: 300 });
    await new Promise((r) => setTimeout(r, 50));
    const other = new URL(url);
    other.pathname = '/not-this-one';
    expect((await fetch(other, { method: 'POST', body: `code=${CODE}&email=a@b.example` })).status).toBe(404);
    await expect(signedIn).rejects.toThrow(/timed out/);
    expect(store.load()).toBeUndefined();
  });

  it('renews a token near its end at the backend, not at Google', async () => {
    expiresIn = 60_000; // inside the five-minute window
    const { store } = await signIn([{ code: CODE, email: 'me@home.example' }]);
    expiresIn = 12 * 3600_000;
    expect(await freshIdToken(store)).toBe('bwz_next');
    expect(seen.some((r) => r.path === '/v1/code-signin/refresh' && r.body.refresh_token === 'bwr_one')).toBe(true);
    expect(store.load()!.id_token).toBe('bwz_next');
  });

  it('ends the session at the backend on sign-out', async () => {
    const { credential } = await signIn([{ code: CODE, email: 'me@home.example' }]);
    await signOutCode(base, credential);
    expect(seen.find((r) => r.path === '/v1/code-signin/sign-out')?.body).toEqual({ refresh_token: 'bwr_one' });
  });
});
