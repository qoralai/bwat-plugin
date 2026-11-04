/**
 * Where a signed-in member's Google credential lives: one directory per bwat backend, under
 * BWAT_HOME (default ~/.bwat), shared by every client on the machine so one sign-in serves all.
 * Credentials are keyed by the backend's base URL, so a token issued for one bwat install is
 * never offered to another (one company per install).
 *
 * Files are user-only (0700 directories, 0600 files; Windows relies on the profile ACL) and
 * written atomically: a temp file in the same directory, then a rename. A change that reads and
 * then writes (sign-in, refresh) runs under the store's lock, so two clients never refresh at once.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { backendRoot } from '../guard/hosts.js';

export interface Credential {
  email: string;
  sub: string;
  id_token: string;
  refresh_token?: string;
  /** ISO 8601. */
  expires_at: string;
  /** The Google client signed in with: the refresh token is bound to it, so a refresh uses it too. */
  client_id: string;
  client_secret?: string;
}

export interface CredentialStore {
  /** This backend's directory; the lock lives here too. */
  readonly dir: string;
  /** The backend's API root: a code sign-in (auth/code.ts) refreshes there. */
  readonly baseUrl?: URL;
  load(): Credential | undefined;
  save(credential: Credential): void;
  /** Forget the sign-in for this backend. */
  clear(): void;
  /** Run fn holding this backend's lock, waiting for any other holder first. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

const FILE = 'google.json';
const LOCK = 'google.lock';
/** Longer than any holder keeps it (a refresh times out after 10 s). */
const LOCK_WAIT_MS = 15_000;

export function bwatHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.BWAT_HOME || join(homedir(), '.bwat');
}

export function credentialStore(baseUrl: URL, home = bwatHome()): CredentialStore {
  const backend = backendRoot(baseUrl);
  const dir = join(home, 'auth', createHash('sha256').update(backend).digest('hex').slice(0, 16));
  const file = join(dir, FILE);

  function ensureDir() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to directories it creates; tighten the store's own two levels
    // either way. BWAT_HOME itself is the member's choice and is left alone.
    for (const d of [join(home, 'auth'), dir]) chmodSync(d, 0o700);
  }

  return {
    dir,
    baseUrl,
    load() {
      let stored: unknown;
      try {
        stored = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return undefined;
      }
      // Anything that is not a whole credential for this backend is treated as absent.
      return asCredential(stored, backend);
    },
    clear() {
      rmSync(file, { force: true });
    },
    save(credential) {
      ensureDir();
      const temp = join(dir, `${FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      try {
        writeFileSync(temp, `${JSON.stringify({ ...credential, base_url: backend }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(temp, file);
      } catch (err) {
        rmSync(temp, { force: true });
        throw err;
      }
    },
    async withLock(fn) {
      ensureDir();
      const lock = join(dir, LOCK);
      const token = `${process.pid}.${randomBytes(4).toString('hex')}`;
      const deadline = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        try {
          writeFileSync(lock, token, { mode: 0o600, flag: 'wx' });
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
        // A lock left by a killed process is never taken over: the member removes it.
        if (Date.now() >= deadline) {
          throw new Error(`another bwat-plugin is signing in or refreshing; if none is running, delete ${lock}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      try {
        return await fn();
      } finally {
        // Only our own: had it been deleted by hand, another process may hold it now.
        try {
          if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true });
        } catch {
          // Already gone.
        }
      }
    },
  };
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function asCredential(value: unknown, backend: string): Credential | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  // The directory name is a hash; the file still says which backend it belongs to, and must agree.
  if (r.base_url !== backend) return undefined;
  if (![r.email, r.sub, r.id_token, r.expires_at, r.client_id].every(nonEmpty)) return undefined;
  if ([r.refresh_token, r.client_secret].some((v) => v !== undefined && !nonEmpty(v))) return undefined;
  if (Number.isNaN(Date.parse(r.expires_at as string))) return undefined;
  const { email, sub, id_token, refresh_token, expires_at, client_id, client_secret } = r as unknown as Credential;
  return { email, sub, id_token, refresh_token, expires_at, client_id, client_secret };
}
