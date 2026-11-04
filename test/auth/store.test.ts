import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Credential, credentialStore } from '../../src/auth/store.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bwat-store-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const credential = (email = 'member@bwat.example'): Credential => ({
  email,
  sub: '1',
  id_token: 'id',
  refresh_token: 'refresh',
  expires_at: '2026-10-02T12:00:00.000Z',
  client_id: 'desktop-client',
  client_secret: 'desktop-secret',
});
const store = (url: string) => credentialStore(new URL(url), home);
const entries = () => readdirSync(home, { recursive: true, withFileTypes: true });

describe('credential store', () => {
  it('keeps one credential per backend', () => {
    store('https://bwat.example/v1').save(credential());
    expect(store('https://bwat.customer.example/v1').load()).toBeUndefined();
    expect(store('https://bwat.example/v2').load()).toBeUndefined();
  });

  it('treats equivalent spellings of one base URL as the same backend', () => {
    store('https://BWAT.example/v1/').save(credential());
    expect(store('https://bwat.example/v1').load()?.email).toBe('member@bwat.example');
  });

  it('returns exactly the credential fields, nothing the store adds', () => {
    store('https://bwat.example/v1').save(credential());
    expect(store('https://bwat.example/v1').load()).toEqual(credential());
  });

  it('replaces the credential on save and leaves no temporary files', () => {
    const s = store('https://bwat.example/v1');
    s.save(credential());
    s.save(credential('second@bwat.example'));
    expect(s.load()?.email).toBe('second@bwat.example');
    expect(entries().filter((e) => e.isFile()).map((e) => e.name)).toEqual(['google.json']);
  });

  it.skipIf(process.platform === 'win32')('is readable by the user only', () => {
    store('https://bwat.example/v1').save(credential());
    for (const e of entries()) expect(statSync(join(e.parentPath, e.name)).mode & 0o077).toBe(0);
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['not JSON', '{nope'],
    ['a record missing its token', JSON.stringify({ base_url: 'https://bwat.example/v1', email: 'a@b.example', sub: '1', client_id: 'c', expires_at: '2026-10-02T12:00:00.000Z' })],
    ['an empty email', JSON.stringify({ base_url: 'https://bwat.example/v1', email: '', sub: '1', id_token: 'x', client_id: 'c', expires_at: '2026-10-02T12:00:00.000Z' })],
    ['a non-string refresh token', JSON.stringify({ base_url: 'https://bwat.example/v1', email: 'a@b.example', sub: '1', id_token: 'x', refresh_token: 5, client_id: 'c', expires_at: '2026-10-02T12:00:00.000Z' })],
    ['a record without the Google client it was signed in with', JSON.stringify({ base_url: 'https://bwat.example/v1', email: 'a@b.example', sub: '1', id_token: 'x', expires_at: '2026-10-02T12:00:00.000Z' })],
    ['an unparseable expiry', JSON.stringify({ base_url: 'https://bwat.example/v1', email: 'a@b.example', sub: '1', id_token: 'x', client_id: 'c', expires_at: 'soon' })],
    ["another backend's record", JSON.stringify({ base_url: 'https://elsewhere.example/v1', email: 'a@b.example', sub: '1', id_token: 'x', client_id: 'c', expires_at: '2026-10-02T12:00:00.000Z' })],
  ])('treats a stored file holding %s as not signed in', (_label, content) => {
    const s = store('https://bwat.example/v1');
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, 'google.json'), content);
    expect(s.load()).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('tightens its own directories even when they already exist loosely', () => {
    const s = store('https://bwat.example/v1');
    mkdirSync(s.dir, { recursive: true, mode: 0o755 });
    chmodSync(join(home, 'auth'), 0o755);
    chmodSync(s.dir, 0o755);
    s.save(credential());
    expect(statSync(join(home, 'auth')).mode & 0o077).toBe(0);
    expect(statSync(s.dir).mode & 0o077).toBe(0);
  });
});

describe('credential store lock', () => {
  const locks = () => entries().filter((e) => e.name.startsWith('google.lock'));
  afterEach(() => vi.useRealTimers());

  it('lets one caller in at a time', async () => {
    const s = store('https://bwat.example/v1');
    let inside = 0;
    let most = 0;
    const order: string[] = [];
    const enter = async (name: string, until: Promise<void>) => {
      most = Math.max(most, ++inside);
      order.push(name);
      await until;
      inside--;
    };
    let releaseA!: () => void;
    const a = s.withLock(() => enter('A', new Promise<void>((resolve) => (releaseA = resolve))));
    const b = s.withLock(() => enter('B', Promise.resolve()));
    await Promise.resolve();

    expect(order).toEqual(['A']);
    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(['A', 'B']);
    expect(most).toBe(1);
    expect(locks()).toEqual([]);
  });

  it('gives up on a lock held too long, naming the file to delete', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const s = store('https://bwat.example/v1');
    const lock = join(s.dir, 'google.lock');
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(lock, 'another holder');
    const fn = vi.fn(async () => {});

    const result = expect(s.withLock(fn)).rejects.toThrow(
      `another bwat-plugin is signing in or refreshing; if none is running, delete ${lock}`,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fn).not.toHaveBeenCalled();
    expect(readFileSync(lock, 'utf8')).toBe('another holder');
  });

  it('on release, leaves a lock it does not hold', async () => {
    const s = store('https://bwat.example/v1');
    const lock = join(s.dir, 'google.lock');
    await s.withLock(async () => {
      // Someone deleted this holder's lock by hand and another process took it.
      rmSync(lock);
      writeFileSync(lock, 'another holder');
    });
    expect(readFileSync(lock, 'utf8')).toBe('another holder');
  });

  it('removes its own lock on release', async () => {
    const s = store('https://bwat.example/v1');
    await s.withLock(async () => expect(locks()).toHaveLength(1));
    expect(locks()).toEqual([]);
  });
});
