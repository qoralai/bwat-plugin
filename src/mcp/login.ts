/**
 * Sign-in started from the client (/bwat:login). The Google Desktop client comes from
 * the bwat backend (GET /auth/desktop-client), so nothing is typed but the Google sign-in; an
 * environment BWAT_GOOGLE_CLIENT_ID still wins. The tool answers as soon as the browser is sent
 * to Google, with the link in case it did not open; this server keeps the loopback redirect
 * open until Google sends the person back, and stores the sign-in then.
 */
import { spawn } from 'node:child_process';
import { createApiClient } from '../api/client.js';
import { codeLogin } from '../auth/code.js';
import { login } from '../auth/google.js';
import type { CredentialStore } from '../auth/store.js';
import { googleClient } from '../config.js';

export type DesktopClient = { id: string; secret?: string };

/** How this install signs people in: Google with its Desktop client, its code (a single-computer install), or neither. */
export type SignInMethod = { kind: 'google'; client: DesktopClient } | { kind: 'code' } | undefined;

export async function signInMethod(baseUrl: URL): Promise<SignInMethod> {
  const fromEnv = googleClient();
  if (fromEnv) return { kind: 'google', client: fromEnv };
  // The guarded client: the host guard, no redirects, a bounded answer, and the person's proxy.
  const api = createApiClient({ baseUrl, token: async () => undefined });
  let body: { client_id?: unknown; client_secret?: unknown; code_signin?: unknown };
  try {
    body = (await api.getOpen(['auth', 'desktop-client'])) as typeof body;
  } finally {
    await api.close();
  }
  if (body.code_signin === true) return { kind: 'code' };
  if (typeof body.client_id !== 'string' || !body.client_id) return undefined;
  return { kind: 'google', client: { id: body.client_id, ...(typeof body.client_secret === 'string' && body.client_secret ? { secret: body.client_secret } : {}) } };
}

/** The Desktop client to sign in with, or undefined when the install has none. */
export async function desktopClient(baseUrl: URL): Promise<DesktopClient | undefined> {
  const method = await signInMethod(baseUrl);
  return method?.kind === 'google' ? method.client : undefined;
}

/** Opens the URL in the person's browser; BWAT_NO_BROWSER=1 (SSH, a headless box) only shows it. */
export function openBrowser(url: string): boolean {
  if (process.env.BWAT_NO_BROWSER === '1') return false;
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]] // `start` would split the URL at each &
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  return true;
}

/** An abandoned sign-in closes its loopback server after this long. */
const SIGN_IN_MS = 10 * 60_000;

/** The sign-in this server is waiting on, if any: asking again answers it rather than starting another. */
let pending: Promise<string> | undefined;

/**
 * Starts the sign-in; resolves with its link once the browser has been sent to it: Google's, or
 * for a code sign-in (`code`, the backend's API root) this server's own page on 127.0.0.1,
 * where the person types the code, so it never passes through the chat.
 */
export async function startSignIn(
  store: CredentialStore,
  client: DesktopClient | { code: URL },
): Promise<{ sign_in_url: string; browser_opened: boolean }> {
  if (pending) {
    const url = await pending;
    return { sign_in_url: url, browser_opened: openBrowser(url) };
  }
  let opened = false;
  const started = new Promise<string>((resolve, reject) => {
    const browser = {
      timeoutMs: SIGN_IN_MS,
      openBrowser: (url: string) => {
        opened = openBrowser(url);
        resolve(url);
      },
      // stdout is MCP's: the person reads the link from the tool's answer instead.
      say: () => undefined,
    };
    ('code' in client ? codeLogin(store, { ...browser, baseUrl: client.code }) : login(store, { ...browser, client }))
      .catch((err: Error) => {
        process.stderr.write(`bwat-plugin: sign-in failed: ${err.message}\n`);
        reject(err);
      })
      .finally(() => (pending = undefined));
  });
  pending = started;
  return { sign_in_url: await started, browser_opened: opened };
}
