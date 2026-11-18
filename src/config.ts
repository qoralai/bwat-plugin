import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bwatHome, holdLock } from './auth/store.ts';
import { baseUrlProblem } from './guard/hosts.ts';

/**
 * The bwat backend this install talks to. It is set at install time: nothing is baked in,
 * because every company runs its own backend. Undefined when unset or empty.
 * Throws with a readable reason when the value is unusable.
 * The plain board address (no path) means its API, under /v1; any other path is used as given.
 */
export function backendBaseUrl(env: NodeJS.ProcessEnv = process.env): URL | undefined {
  const value = env.BWAT_BASE_URL;
  return value ? parseBaseUrl(value) : undefined; // unset or empty: no backend configured
}

/** One bwat address, from wherever it was given; throws naming `label` when it is unusable. */
export function parseBaseUrl(value: string, label = 'BWAT_BASE_URL'): URL {
  const problem = baseUrlProblem(value);
  if (problem) throw new Error(`${label} ${problem}`);
  const url = new URL(value);
  // One spelling per backend: no trailing slash, so https://x/v1/ and https://x/v1 are the same one.
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  return url;
}

/** Where bwat_login keeps the address it was given, for a client that cannot set BWAT_BASE_URL (Codex). */
const SAVED = 'base_url';

/**
 * The kept file, read once: its record as written (the address, then a random tag new with every
 * save, so two saves of one address differ) and the address in it. A record whose address is no
 * longer usable has no url, so the server still starts; bwat_logout clears it. Empty when none.
 */
export function keptBaseUrl(home: string = bwatHome()): { url?: URL; record?: string } {
  let record: string;
  try {
    record = readFileSync(join(home, SAVED), 'utf8');
  } catch {
    return {};
  }
  try {
    return { url: parseBaseUrl(record.split('\n')[0]!.trim()), record };
  } catch {
    return { record };
  }
}

/** The address bwat_login kept under BWAT_HOME, or undefined when there is none usable. */
export function savedBaseUrl(home: string = bwatHome()): URL | undefined {
  return keptBaseUrl(home).url;
}

/**
 * Keeping and forgetting run under one lock shared by every bwat-plugin process, so a forget's
 * compare and delete never straddle another process's forget and save.
 */
function changingKept<T>(home: string, fn: () => T): Promise<T> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return holdLock(join(home, `${SAVED}.lock`), 'another bwat-plugin is changing the bwat address', async () => fn());
}

/**
 * Keeps the address, unless one is kept already: undefined then, and the kept one stays. Under the
 * lock, so the check and the write are one step; written to a temp file and renamed into place, so
 * a reader (which takes no lock) sees the whole record or none. Answers the record written, for
 * forgetBaseUrl.
 */
export function saveBaseUrl(url: URL, home: string = bwatHome()): Promise<string | undefined> {
  const record = `${url.href}\n${randomBytes(8).toString('hex')}\n`;
  return changingKept(home, () => {
    const file = join(home, SAVED);
    if (existsSync(file)) return undefined;
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, record, { mode: 0o600, flag: 'wx' });
      renameSync(temp, file);
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
    return record;
  });
}

/** Forgets the kept address, but only while it is still the record read or written earlier. */
export async function forgetBaseUrl(home: string, record: string | undefined): Promise<void> {
  if (record === undefined) return;
  await changingKept(home, () => {
    if (keptBaseUrl(home).record === record) rmSync(join(home, SAVED), { force: true });
  });
}

/**
 * The plugin's Google OAuth client (a Desktop client), used to sign in and to refresh the ID token.
 * Its id must be one of the backend's BWAT_GOOGLE_CLIENT_IDS. Google calls a Desktop client's secret
 * not secret, but it is still read from the environment, never shipped. Undefined when the id is unset.
 */
export function googleClient(env: NodeJS.ProcessEnv = process.env): { id: string; secret?: string } | undefined {
  if (!env.BWAT_GOOGLE_CLIENT_ID) return undefined;
  return { id: env.BWAT_GOOGLE_CLIENT_ID, secret: env.BWAT_GOOGLE_CLIENT_SECRET || undefined };
}
