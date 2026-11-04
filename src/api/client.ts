/**
 * The one way the plugin talks to a bwat backend. Every tool goes through here, so the
 * independence and leak rules live here once:
 * - every request URL is rebuilt and checked against the backend's own origin and path;
 * - redirects are never followed;
 * - the bearer token goes only to that checked URL, and never into an error;
 * - an error repeats only a code bwat is known to send, never free text from the response.
 * No retries: a caller that wants one decides per endpoint.
 */
import { Agent, type Dispatcher, EnvHttpProxyAgent, fetch, type Response } from 'undici';
import { backendRoot, baseUrlProblem, isLoopbackHttp } from '../guard/hosts.js';

/** Codes the bwat backend sends. Anything else it sends becomes backend_error. */
const KNOWN_CODES = new Set([
  'unauthorized', 'forbidden', 'not_onboarded', 'owner_required', 'not_found', 'invalid_body',
  'invalid_query', 'bad_url', 'too_large', 'too_long', 'unsupported_media_type', 'session_unreachable',
  'meeting_deleted', 'last_owner', 'member_exists', 'domain_not_allowed', 'mapping_taken', 'stale',
  'internal', 'not_configured', 'secret_unavailable', 'not_a_zoom_meeting_link', 'not_live',
  // A code sign-in's refusals (POST /code-signin).
  'wrong_code', 'bad_email', 'removed', 'rate_limited', 'signed_out',
]);

const BY_STATUS: Record<number, string> = {
  400: 'invalid_body', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 413: 'too_large',
  414: 'too_long', 415: 'unsupported_media_type', 500: 'internal',
};

/** Codes the client raises itself, beside the backend's. */
export type ClientErrorCode =
  | 'not_signed_in' | 'sign_in_expired' | 'bad_path' | 'redirect_refused' | 'timeout' | 'bad_response'
  | 'too_large_response' | 'backend_unavailable' | 'backend_error';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(status === undefined ? code : `${code} (HTTP ${status})`);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /** The API root, e.g. https://bwat.example.com/v1. */
  baseUrl: URL;
  /** The bearer token, or undefined when signed out. Its own failures surface unchanged. */
  token: () => Promise<string | undefined>;
  /** Where proxy settings are read from. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

type Query = Record<string, string | number | boolean | undefined>;
/** Path segments under the API root, e.g. ['me', 'inbox', messageId]. Each is encoded once, here. */
type Segments = readonly string[];

export function createApiClient(options: ApiClientOptions) {
  const problem = baseUrlProblem(options.baseUrl.href);
  if (problem) throw new Error(`bwat base URL ${problem}`);
  const base = new URL(backendRoot(options.baseUrl));
  const root = `${base.href}/`;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;

  // Loopback http never goes through a proxy: the token must not leave the machine.
  const dispatcher: Dispatcher = isLoopbackHttp(base) ? new Agent() : proxyAgent(options.env ?? process.env);

  /** One request; `open` sends no token, for the few routes bwat answers before anyone signs in. */
  async function request(method: string, path: Segments, query?: Query, body?: unknown, open = false): Promise<unknown> {
    const url = resolve(path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const token = open ? undefined : await options.token();
    if (!open && !token) throw new ApiError('not_signed_in');

    const signal = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        dispatcher,
        signal,
        redirect: 'manual',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw transportError(err);
    }

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined); // cleanup must not replace the real error
      throw new ApiError('redirect_refused', res.status);
    }

    let text: string;
    try {
      text = await readBounded(res.body, maxBytes);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw transportError(err);
    }

    if (res.ok) {
      if (res.status === 204) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        throw new ApiError('bad_response', res.status);
      }
    }
    throw new ApiError(errorCode(text, res.status), res.status);
  }

  /** <root><encoded segments>. A dot or empty segment is refused; nothing else can leave the root. */
  function resolve(path: Segments): URL {
    if (path.length === 0 || path.some((s) => s === '' || s === '.' || s === '..')) throw new ApiError('bad_path');
    let encoded: string;
    try {
      encoded = path.map(encodeURIComponent).join('/');
    } catch {
      throw new ApiError('bad_path'); // e.g. a lone surrogate, which has no encoding
    }
    const url = new URL(root + encoded);
    // Belt and braces: encoding already keeps every segment inside the root, on the base's own host.
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`))
      throw new ApiError('bad_path');
    return url;
  }

  return {
    /** Close this client's connections. Create one client per backend and close it on shutdown. */
    close: async (): Promise<void> => {
      await dispatcher.close();
    },
    get: (path: Segments, query?: Query) => request('GET', path, query),
    /** A GET bwat answers without a sign-in (GET /auth/desktop-client), with every other guard kept. */
    getOpen: (path: Segments) => request('GET', path, undefined, undefined, true),
    post: (path: Segments, body?: unknown) => request('POST', path, undefined, body),
    /** A POST bwat answers without a sign-in (POST /code-signin), with every other guard kept. */
    postOpen: (path: Segments, body?: unknown) => request('POST', path, undefined, body, true),
    patch: (path: Segments, body?: unknown) => request('PATCH', path, undefined, body),
    put: (path: Segments, body?: unknown) => request('PUT', path, undefined, body),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function proxyAgent(env: NodeJS.ProcessEnv): Dispatcher {
  // Lower case first, as undici reads them; an empty string, never undefined, for a missing value,
  // because undefined makes undici fall back to the real process environment.
  const pick = (name: string) => env[name.toLowerCase()] ?? env[name] ?? '';
  return new EnvHttpProxyAgent({
    httpProxy: pick('HTTP_PROXY'),
    httpsProxy: pick('HTTPS_PROXY'),
    noProxy: pick('NO_PROXY'),
  });
}

async function readBounded(body: Response['body'], maxBytes: number): Promise<string> {
  if (!body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new ApiError('too_large_response'); // leaving the loop cancels the stream
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function errorCode(text: string, status: number): string {
  try {
    const code = (JSON.parse(text) as { error?: unknown }).error;
    if (typeof code === 'string') return KNOWN_CODES.has(code) ? code : 'backend_error';
  } catch {
    // Not JSON: fall back to what the status says.
  }
  return BY_STATUS[status] ?? (status >= 500 ? 'backend_unavailable' : 'backend_error');
}

function transportError(err: unknown): ApiError {
  const name = (err as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return new ApiError('timeout');
  return new ApiError('backend_unavailable');
}
