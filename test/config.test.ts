import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Credential, credentialStore, holdLock } from '../src/auth/store.ts';
import { forgetBaseUrl, keptBaseUrl, saveBaseUrl } from '../src/config.ts';
import { toolsFor } from '../src/mcp/tools.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bwat-config-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

const file = () => join(home, 'base_url');
const lock = () => join(home, 'base_url.lock');
const kept = () => (existsSync(file()) ? readFileSync(file(), 'utf8') : undefined);
const turns = () => new Promise((resolve) => setTimeout(resolve, 100));

/**
 * Holds the address lock as another bwat-plugin process would (the lock is a file, so a holder in
 * this process stands in for one in another), running `meanwhile` once the caller under test waits.
 */
async function whileAnotherHolds(caller: () => Promise<unknown>, meanwhile: () => void) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const other = holdLock(lock(), 'busy', async () => {
    entered();
    await held;
  });
  await inside;
  const waiting = caller();
  await turns();
  meanwhile();
  release();
  await other;
  return waiting;
}

describe('the kept bwat address, shared by every bwat-plugin process', () => {
  it('reads the address and its record in one read', async () => {
    const record = await saveBaseUrl(new URL('https://bwat.example/v1'), home);
    expect(keptBaseUrl(home)).toEqual({ url: new URL('https://bwat.example/v1'), record });
  });

  it('keeps a new address whole, leaving no temp file, and never replaces one kept already', async () => {
    const record = await saveBaseUrl(new URL('https://bwat.example/v1'), home);
    expect(await saveBaseUrl(new URL('https://bwat.other.example/v1'), home)).toBeUndefined();
    expect(kept()).toBe(record);
    expect(readdirSync(home).sort()).toEqual(['base_url']);
  });

  it('keeps the record of an unusable address, so it can still be forgotten', async () => {
    writeFileSync(file(), 'not an address\n');
    expect(keptBaseUrl(home)).toEqual({ record: 'not an address\n' });
    await forgetBaseUrl(home, 'not an address\n');
    expect(kept()).toBeUndefined();
  });

  it('does not compare and delete while another process is changing it, so its replacement survives', async () => {
    const old = (await saveBaseUrl(new URL('https://bwat.example/v1'), home))!;
    const replacement = 'https://bwat.other.example/v1\nnewer-tag\n';
    await whileAnotherHolds(
      () => forgetBaseUrl(home, old),
      () => {
        // Still there: the forget is waiting, not between its compare and its delete.
        expect(kept()).toBe(old);
        // The other process signs out of it and keeps a new address.
        rmSync(file());
        writeFileSync(file(), replacement);
      },
    );
    expect(kept()).toBe(replacement);
  });

  it('forgets its own record once the other process is done', async () => {
    const old = (await saveBaseUrl(new URL('https://bwat.example/v1'), home))!;
    await whileAnotherHolds(
      () => forgetBaseUrl(home, old),
      () => expect(kept()).toBe(old),
    );
    expect(kept()).toBeUndefined();
  });

  it('does not keep an address while another process is changing it', async () => {
    const saved = await whileAnotherHolds(
      () => saveBaseUrl(new URL('https://bwat.example/v1'), home),
      () => expect(kept()).toBeUndefined(),
    );
    expect(kept()).toBe(saved);
    expect(existsSync(lock())).toBe(false);
  });

  it('gives up on a lock left by a killed process, naming the file to delete', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    writeFileSync(file(), 'https://bwat.example/v1\ntag\n');
    writeFileSync(lock(), 'a killed holder');
    const result = expect(forgetBaseUrl(home, 'https://bwat.example/v1\ntag\n')).rejects.toThrow(
      `another bwat-plugin is changing the bwat address; if none is running, delete ${lock()}`,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(kept()).toBe('https://bwat.example/v1\ntag\n');
  });

  it('bwat_logout forgets the record its address was resolved from, not one kept since', async () => {
    const resolvedFrom = 'https://bwat.example/v1\nresolved-tag\n';
    const keptSince = 'https://bwat.example/v1\nnewer-tag\n';
    // Another process replaced the record after this call's backend was resolved.
    writeFileSync(file(), keptSince);
    const logout = toolsFor('codex').find((t) => t.name === 'bwat_logout')!;
    const result = await logout.handler({}, { client: 'codex', version: '0', home, baseUrlFromEnv: false, keptRecord: resolvedFrom });
    expect(result.isError).toBeFalsy();
    expect(kept()).toBe(keptSince);
  });

  it('bwat_logout waits for a sign-in in another process before it reads and clears the credential', async () => {
    const baseUrl = 'https://bwat.example/v1';
    const store = credentialStore(new URL(baseUrl), home);
    const signedIn = (email: string): Credential => ({
      email,
      sub: '1',
      id_token: 'id',
      expires_at: '2026-10-02T12:00:00.000Z',
      client_id: 'desktop-client',
    });
    store.save(signedIn('before@bwat.example'));
    const record = (await saveBaseUrl(new URL(baseUrl), home))!;
    const logout = toolsFor('codex').find((t) => t.name === 'bwat_logout')!;

    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    // Another process signing in holds the store's lock.
    const signIn = store.withLock(async () => {
      entered();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await inside;
    const out = logout.handler({}, { client: 'codex', version: '0', home, baseUrlFromEnv: false, baseUrl, keptRecord: record });
    await turns();
    // Waiting: it has neither read nor cleared the credential yet.
    expect(store.load()?.email).toBe('before@bwat.example');
    store.save(signedIn('during@bwat.example'));
    release();
    await signIn;

    expect((await out).isError).toBeFalsy();
    // The sign-out ends the sign-in it found once it got the lock, not a stale read of the old one.
    expect(store.load()).toBeUndefined();
    expect(kept()).toBeUndefined();
  });
});
