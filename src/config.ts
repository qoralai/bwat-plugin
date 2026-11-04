import { baseUrlProblem } from './guard/hosts.js';

/**
 * The bwat backend this install talks to. It is set at install time: nothing is baked in,
 * because every company runs its own backend. Undefined when unset or empty.
 * Throws with a readable reason when the value is unusable.
 * The plain board address (no path) means its API, under /v1; any other path is used as given.
 */
export function backendBaseUrl(env: NodeJS.ProcessEnv = process.env): URL | undefined {
  const value = env.BWAT_BASE_URL;
  if (!value) return undefined; // unset or empty: no backend configured
  const problem = baseUrlProblem(value);
  if (problem) throw new Error(`BWAT_BASE_URL ${problem}`);
  const url = new URL(value);
  if (url.pathname === '/') url.pathname = '/v1';
  return url;
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
