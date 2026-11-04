/**
 * Google sign-in for an installed app (RFC 8252): the browser is sent to Google's consent page,
 * which redirects back to a one-shot server on 127.0.0.1 at an ephemeral port. PKCE (S256) binds
 * the code to this process, and `state` refuses a redirect this sign-in did not start.
 *
 * The bwat backend takes the resulting Google ID token as its bearer, so that token is what is
 * stored, refreshed and sent. No token is ever written to a message.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CODE_CLIENT, refreshCode } from './code.js';
import { signInPage } from './signin-page.js';
import type { Credential, CredentialStore } from './store.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** An ID token with less than this left is refreshed before use. */
const REFRESH_WITHIN_MS = 5 * 60_000;

export interface GoogleClient {
  id: string;
  secret?: string;
}

export interface LoginOptions {
  client: GoogleClient;
  /** Shows the person Google's consent page; should not throw. */
  openBrowser: (url: string) => void;
  /** One human-readable line, never holding a token. */
  say: (line: string) => void;
  authUrl?: string;
  tokenUrl?: string;
  /** Give up, and close the loopback server, if nobody comes back within this long. */
  timeoutMs?: number;
}

export async function login(store: CredentialStore, options: LoginOptions): Promise<Credential> {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const auth = new URL(options.authUrl ?? GOOGLE_AUTH_URL);
  auth.search = new URLSearchParams({
    client_id: options.client.id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent', // ...every time, not only on this Google account's first consent
  }).toString();

  let code: string;
  try {
    code = await new Promise<string>((resolve, reject) => {
      if (options.timeoutMs) {
        setTimeout(() => reject(new Error('sign-in timed out: nobody came back from Google')), options.timeoutMs).unref();
      }
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/') {
          res.writeHead(404).end(); // e.g. the browser asking for a favicon
          return;
        }
        const answer = (status: number, heading: string, line: string) =>
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(signInPage(heading, line));
        if (url.searchParams.get('state') !== state) {
          answer(400, 'Sign-in refused', 'This response does not belong to the sign-in in progress. Run /bwat:login again.');
          reject(new Error('sign-in refused: the redirect carried the wrong state'));
          return;
        }
        const received = url.searchParams.get('code');
        if (!received) {
          answer(400, 'Sign-in not completed', 'Run /bwat:login to try again.');
          reject(new Error('sign-in was not completed in the browser'));
          return;
        }
        answer(200, "You're signed in", 'You can close this tab and go back to Claude.');
        resolve(received);
      });
      options.say(`Opening your browser to sign in with Google. If it does not open, visit:\n${auth.href}`);
      options.openBrowser(auth.href);
    });
  } finally {
    server.close();
    server.closeAllConnections();
  }

  const tokens = await tokenRequest(options.tokenUrl, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: options.client.id,
    ...(options.client.secret ? { client_secret: options.client.secret } : {}),
  });
  const identity = fromIdToken(tokens.id_token);
  return store.withLock(async () => {
    // Google sends a refresh token only on a member's first consent: a later sign-in keeps the
    // one stored for that same account.
    const previous = store.load();
    const kept = previous?.sub === identity.sub ? previous.refresh_token : undefined;
    const credential = { ...identity, refresh_token: tokens.refresh_token ?? kept, client_id: options.client.id, client_secret: options.client.secret };
    store.save(credential);
    return credential;
  });
}

/**
 * The ID token to send, refreshed first when it has five minutes or less left. Undefined when
 * nobody is signed in. Throws when it needs a refresh that cannot happen.
 */
export async function freshIdToken(store: CredentialStore, options: { tokenUrl?: string } = {}): Promise<string | undefined> {
  const usable = (c: Credential) => Date.parse(c.expires_at) - Date.now() > REFRESH_WITHIN_MS;
  const current = store.load();
  if (!current || usable(current)) return current?.id_token;

  return store.withLock(async () => {
    // Another client may have refreshed while this one waited for the lock.
    const latest = store.load();
    if (!latest || usable(latest)) return latest?.id_token;
    if (!latest.refresh_token) throw new Error('sign-in expired; run bwat-plugin login');
    // A code sign-in renews at the backend, not at Google.
    if (latest.client_id === CODE_CLIENT) {
      if (!store.baseUrl) throw new Error('sign-in expired; run /bwat:login');
      const renewed = { ...latest, ...(await refreshCode(store.baseUrl, latest)) };
      store.save(renewed);
      return renewed.id_token;
    }
    const tokens = await tokenRequest(options.tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: latest.refresh_token,
      client_id: latest.client_id,
      ...(latest.client_secret ? { client_secret: latest.client_secret } : {}),
    });
    // Google normally keeps the refresh token and sends no new one.
    const refreshed = { ...latest, ...fromIdToken(tokens.id_token), refresh_token: tokens.refresh_token ?? latest.refresh_token };
    store.save(refreshed);
    return refreshed.id_token;
  });
}

async function tokenRequest(
  tokenUrl = GOOGLE_TOKEN_URL,
  form: Record<string, string>,
): Promise<{ id_token: string; refresh_token?: string }> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(10_000),
  });
  // The status only: Google's error body is not repeated.
  if (!res.ok) throw new Error(`Google refused the token request (HTTP ${res.status})`);
  const body = (await res.json()) as { id_token?: unknown; refresh_token?: unknown };
  if (typeof body.id_token !== 'string') throw new Error('Google sent no ID token');
  return { id_token: body.id_token, refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : undefined };
}

/** The account and expiry an ID token names. Not verified here: the backend verifies every token it is sent. */
function fromIdToken(idToken: string): Pick<Credential, 'email' | 'sub' | 'id_token' | 'expires_at'> {
  let claims: { email?: unknown; sub?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    throw new Error('Google sent an unreadable ID token');
  }
  const { email, sub, exp } = claims;
  if (typeof email !== 'string' || typeof sub !== 'string' || typeof exp !== 'number')
    throw new Error('Google sent an ID token without an email, subject or expiry');
  return { email, sub, id_token: idToken, expires_at: new Date(exp * 1000).toISOString() };
}
