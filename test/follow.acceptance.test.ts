import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialStore } from '../src/auth/store.js';
import { runBundleAsync } from './bundle.js';

// Outside-in: `follow` through the shipped bundle, against a throwaway BWAT_HOME and a fake backend
// that answers each transcript read with the next scripted reply.
const OCC = 'occ/1==';

type Line = [epoch: number, seq: number, label: string, text: string];
const reply = (state: string, lines: Line[]) => ({
  status: 200,
  body: {
    occurrence_state: state,
    segments: lines.map(([epoch, seq, label, text]) => ({ epoch, seq, speaker: { label, member_id: null, zoom_id: 'z' }, text })),
  },
});
const broken = { status: 500, body: { error: 'internal' } };

let home: string;
let backend: Server;
let base: string;
let script: { status: number; body: object }[];
let seen: string[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'bwat-home-'));
  seen = [];
  backend = createServer((req, res) => {
    seen.push(req.url!);
    const next = script.shift() ?? reply('ended', []);
    res.writeHead(next.status, { 'content-type': 'application/json' }).end(JSON.stringify(next.body));
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(backend.address() as AddressInfo).port}/v1`;
});
afterEach(async () => {
  await new Promise((r) => backend.close(r));
  rmSync(home, { recursive: true, force: true });
});

const signIn = () =>
  credentialStore(new URL(base), home).save({
    email: 'member@bwat.example',
    sub: '1234567890',
    id_token: 'eyJ.id-token.sig',
    refresh_token: '1//refresh',
    client_id: 'desktop-client',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });

const follow = (...args: string[]) =>
  runBundleAsync(['follow', OCC, '--every', '0.05', ...args], { BWAT_HOME: home, BWAT_BASE_URL: base });

describe('bwat-plugin follow', () => {
  it('prints only lines said after it started, in order, each with its cursor, until the meeting ends', async () => {
    signIn();
    script = [
      reply('live', [[1, 1, 'Ana', 'already said']]),
      reply('live', [[1, 1, 'Ana', 'already said'], [2, 1, 'Bo', 'later epoch'], [1, 2, 'Ana', 'new']]),
      reply('live', [[1, 2, 'Ana', 'new'], [2, 1, 'Bo', 'later epoch']]),
      reply('ended', [[2, 1, 'Bo', 'later epoch'], [2, 2, 'Bo', 'bye']]),
    ];
    const run = await follow();
    expect(run.stdout).toBe('[1:2] Ana: new\n[2:1] Bo: later epoch\n[2:2] Bo: bye\n--- meeting ended\n');
    expect(run.status).toBe(0);
    expect(seen[0]).toBe(`/v1/meetings/${encodeURIComponent(OCC)}/transcript?tail=100`);
  });

  it('starts after the line --after names, and keeps each line, speaker and text, on one line', async () => {
    signIn();
    script = [reply('abandoned', [[1, 1, 'Ana', 'shown'], [1, 2, 'Ana', 'not yet shown'], [1, 3, 'Bo\u2028by\u2029name', 'a chat\n\nin\rthree parts']])];
    const run = await follow('--after', '1:1');
    expect(run.stdout).toBe('[1:2] Ana: not yet shown\n[1:3] Bo by name: a chat in three parts\n--- meeting abandoned\n');
    expect(run.status).toBe(0);
  });

  it('says a read failed and keeps going', async () => {
    signIn();
    script = [reply('live', []), broken, reply('ended', [[1, 1, 'Ana', 'hello']])];
    const run = await follow();
    expect(run.stdout).toBe('(read failed: internal (HTTP 500))\n[1:1] Ana: hello\n--- meeting ended\n');
    expect(run.status).toBe(0);
  });

  // /bwat:live's command line starts with the plugin's own path, so a permission rule can match its prefix.
  it('takes the bwat address as --base-url', async () => {
    signIn();
    script = [reply('ended', [])];
    const run = await runBundleAsync(['follow', OCC, '--base-url', base], { BWAT_HOME: home, BWAT_BASE_URL: '' });
    expect(run.stdout).toBe('--- meeting ended\n');
    expect(run.status).toBe(0);
  });

  it('needs a sign-in', async () => {
    const run = await follow();
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/^Not signed in to bwat\. .*\/bwat:login/);
    expect(seen).toHaveLength(0);
  });
});
