/**
 * Sign-in with an install's code: a single-computer bwat runs with no
 * Google, and people sign in with the code its setup showed and their email. The code is a
 * password, so it never passes through a chat or a tool argument: like Google's sign-in, the
 * browser opens a one-shot page on 127.0.0.1, the person types the code and email there, and
 * this process sends them to the backend's POST /code-signin. What comes back is a board token
 * (bwz_), the bearer, and a refresh token (bwr_) that mints the next; both are stored, never
 * written to a message.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError, createApiClient } from '../api/client.js';
import { codePage, signInPage } from './signin-page.js';
import type { Credential, CredentialStore } from './store.js';

/** A code sign-in's credential is told apart from a Google one by this client id. */
export const CODE_CLIENT = 'bwat-code';

export interface CodeLoginOptions {
  /** The bwat backend's API root, e.g. http://127.0.0.1:8080/v1. */
  baseUrl: URL;
  /** Shows the person the sign-in page; should not throw. */
  openBrowser: (url: string) => void;
  /** One human-readable line, never holding the code or a token. */
  say: (line: string) => void;
  /** Give up, and close the loopback server, if nobody signs in within this long. */
  timeoutMs?: number;
}

const BODY_LIMIT = 4096;
async function formBody(req: IncomingMessage): Promise<URLSearchParams> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > BODY_LIMIT) throw new Error('too long');
  }
  return new URLSearchParams(text);
}

/** What the backend's refusal means to the person, by its error code. */
const REFUSED: Record<string, string> = {
  wrong_code: "That code didn't work. Check it against what ./bwat setup showed.",
  bad_email: 'That email does not look right.',
  removed: 'An admin removed this email. Ask them to invite you again.',
  rate_limited: 'Too many wrong codes. Wait a minute, then try again.',
};

export async function codeLogin(store: CredentialStore, options: CodeLoginOptions): Promise<Credential> {
  // Only the tab this sign-in opened can submit: the path carries a one-time state.
  const state = randomBytes(16).toString('base64url');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const page = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${state}`;
  const api = createApiClient({ baseUrl: options.baseUrl, token: async () => undefined });

  try {
    return await new Promise<Credential>((resolve, reject) => {
      if (options.timeoutMs) {
        setTimeout(() => reject(new Error('sign-in timed out: nobody signed in on the page')), options.timeoutMs).unref();
      }
      server.on('request', (req, res) => {
        const send = (status: number, html: string) =>
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' }).end(html);
        if (new URL(req.url ?? '/', page).pathname !== `/${state}`) {
          res.writeHead(404).end(); // a favicon, or a page this sign-in did not open
          return;
        }
        if (req.method === 'GET') return send(200, codePage(''));
        if (req.method !== 'POST') return send(405, codePage(''));
        void (async () => {
          let form: URLSearchParams;
          try {
            form = await formBody(req);
          } catch {
            return send(400, codePage('Type the code and your email.'));
          }
          const code = form.get('code')?.trim() ?? '';
          const email = form.get('email')?.trim() ?? '';
          if (!code || !email) return send(400, codePage('Type the code and your email.'));
          let answer: { token?: unknown; refresh_token?: unknown; expires_at?: unknown; member?: { id?: unknown; email?: unknown } };
          try {
            answer = (await api.postOpen(['code-signin'], { code, email })) as typeof answer;
          } catch (err) {
            const known = err instanceof ApiError ? REFUSED[err.code] : undefined;
            // A wrong code may be tried again on the same page; the backend counts each one.
            return send(err instanceof ApiError && err.status && err.status < 500 ? 400 : 502, codePage(known ?? 'bwat could not sign you in just now. Try again.'));
          }
          const { token, refresh_token, expires_at, member } = answer;
          if (typeof token !== 'string' || typeof refresh_token !== 'string' || typeof expires_at !== 'string' || typeof member?.id !== 'string') {
            send(502, codePage('bwat answered something this plugin does not understand. Try again.'));
            return;
          }
          const credential: Credential = {
            email: typeof member.email === 'string' ? member.email : email.toLowerCase(),
            sub: member.id,
            id_token: token,
            refresh_token,
            expires_at,
            client_id: CODE_CLIENT,
          };
          await store.withLock(async () => store.save(credential));
          send(200, signInPage("You're signed in", 'You can close this tab and go back to Claude.'));
          resolve(credential);
        })().catch(reject);
      });
      options.say(`Opening your browser to sign in with this bwat's code. If it does not open, visit:\n${page}`);
      options.openBrowser(page);
    });
  } finally {
    server.close();
    server.closeAllConnections();
    await api.close();
  }
}

/** A code sign-in's next board token (POST /code-signin/refresh), or why it cannot have one. */
export async function refreshCode(baseUrl: URL, credential: Credential): Promise<Pick<Credential, 'id_token' | 'expires_at'>> {
  if (!credential.refresh_token) throw new Error('sign-in expired; run /bwat:login');
  const api = createApiClient({ baseUrl, token: async () => undefined });
  try {
    const answer = (await api.postOpen(['code-signin', 'refresh'], { refresh_token: credential.refresh_token })) as { token?: unknown; expires_at?: unknown };
    if (typeof answer.token !== 'string' || typeof answer.expires_at !== 'string') throw new Error('bwat answered no token');
    return { id_token: answer.token, expires_at: answer.expires_at };
  } finally {
    await api.close();
  }
}

/** Ends a code sign-in at the backend too (POST /code-signin/sign-out), best effort. */
export async function signOutCode(baseUrl: URL, credential: Credential): Promise<void> {
  if (credential.client_id !== CODE_CLIENT || !credential.refresh_token) return;
  const api = createApiClient({ baseUrl, token: async () => undefined });
  try {
    await api.postOpen(['code-signin', 'sign-out'], { refresh_token: credential.refresh_token });
  } catch {
    // Signed out here all the same; the backend's token lapses within 12 hours.
  } finally {
    await api.close();
  }
}
