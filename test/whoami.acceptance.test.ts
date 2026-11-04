import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialStore } from '../src/auth/store.js';
import { runBundleAsync } from './bundle.js';

// Outside-in: `whoami` through the shipped bundle, against a throwaway BWAT_HOME and a fake backend.
const SECRET_ID_TOKEN = 'eyJ.id-token-secret.sig';
const SECRET_REFRESH = '1//refresh-secret';

let home: string;
let backend: Server;
let base: string;
let seen: { path?: string; authorization?: string }[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'bwat-home-'));
  seen = [];
  backend = createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url !== '/v1/me' || req.headers.authorization !== `Bearer ${SECRET_ID_TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ id: 'm-1', email: 'member@bwat.example', display_name: 'Member One', role: 'admin' }));
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(backend.address() as AddressInfo).port}/v1`;
});
afterEach(async () => {
  await new Promise((r) => backend.close(r));
  rmSync(home, { recursive: true, force: true });
});

const whoami = (baseUrl: string | null = base) =>
  runBundleAsync(['whoami'], { BWAT_HOME: home, BWAT_BASE_URL: baseUrl ?? '' });

const signIn = (baseUrl = base, id_token = SECRET_ID_TOKEN) =>
  credentialStore(new URL(baseUrl), home).save({
    email: 'member@bwat.example',
    sub: '1234567890',
    id_token,
    refresh_token: SECRET_REFRESH,
    client_id: 'desktop-client',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });

const noToken = (run: { stdout: string; stderr: string }) => {
  expect(run.stdout + run.stderr).not.toContain(SECRET_ID_TOKEN);
  expect(run.stdout + run.stderr).not.toContain(SECRET_REFRESH);
};

describe('bwat-plugin whoami', () => {
  it('says it is not signed in when nothing is stored', async () => {
    const run = await whoami();
    expect(run.status).toBe(1);
    expect(run.stdout).toBe(`not signed in to ${base}; run bwat-plugin login\n`);
    expect(seen).toHaveLength(0);
  });

  it('asks the backend who the token belongs to and prints the member, never a token', async () => {
    signIn();
    const run = await whoami();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`signed in to ${base} as member@bwat.example (Member One, admin)\n`);
    expect(seen).toEqual([{ path: '/v1/me', authorization: `Bearer ${SECRET_ID_TOKEN}` }]);
    noToken(run);
  });

  it('reports a token the backend refuses by its code alone', async () => {
    signIn(base, 'eyJ.some-other-token.sig');
    const run = await whoami();
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('bwat-plugin: whoami failed: unauthorized (HTTP 401); run bwat-plugin login\n');
    expect(run.stderr).not.toContain('some-other-token');
    noToken(run);
  });

  it('is not signed in to a different bwat', async () => {
    signIn('https://bwat.customer.example/v1');
    expect((await whoami()).status).toBe(1);
  });

  it('needs a base URL to know which account to show', async () => {
    const run = await whoami(null);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/BWAT_BASE_URL/);
  });
});
