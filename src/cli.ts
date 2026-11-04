/**
 * Entry point of dist/bwat-plugin.js: one bundle, one subcommand per job.
 * stdout belongs to MCP while serving, so everything human-readable goes to stderr.
 */
import { parseArgs } from 'node:util';
import { CLIENTS, isClientKind } from './clients.js';
import { bwatApi } from './api/bwat.js';
import { createApiClient } from './api/client.js';
import { codeLogin } from './auth/code.js';
import { freshIdToken, login } from './auth/google.js';
import { credentialStore } from './auth/store.js';
import { backendBaseUrl, googleClient } from './config.js';
import { openBrowser, signInMethod } from './mcp/login.js';
import { serve } from './mcp/server.js';
import { HINTS } from './mcp/tools.js';
import { follow, type Key } from './follow.js';
import { PLUGIN } from './index.js';

declare const __BWAT_VERSION__: string;

function fail(message: string): never {
  process.stderr.write(`${PLUGIN}: ${message}\n`);
  process.exit(2);
}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        client: { type: 'string', default: 'generic' },
        version: { type: 'boolean' },
        every: { type: 'string', default: '30' },
        after: { type: 'string' },
        'base-url': { type: 'string' },
      },
    });
  } catch (err) {
    fail((err as Error).message);
  }
}
const parsed = parse();
const [command, occurrence] = parsed.positionals;

/** The configured backend (--base-url, else BWAT_BASE_URL), or undefined when none is set; exits on an unusable value. */
function baseUrlOrFail(): URL | undefined {
  try {
    const flag = parsed.values['base-url'];
    return backendBaseUrl(flag ? { BWAT_BASE_URL: flag } : process.env);
  } catch (err) {
    fail((err as Error).message);
  }
}

async function main(): Promise<void> {
  if (parsed.values.version) {
    process.stdout.write(`${__BWAT_VERSION__}\n`);
    return;
  }
  switch (command) {
    case 'serve': {
      const { client } = parsed.values;
      if (!isClientKind(client)) fail(`--client must be one of ${CLIENTS.join(', ')}`);
      // Fail fast on a bad backend. Unset is allowed: the backend tools then say it is not configured.
      await serve(client, __BWAT_VERSION__, baseUrlOrFail());
      break;
    }
    case 'login': {
      const baseUrl = baseUrlOrFail() ?? fail('BWAT_BASE_URL is not set: login needs to know which bwat to sign in to');
      const say = (line: string) => process.stderr.write(`${line}\n`);
      // A bwat with no Google signs in with its code, typed on a page on this computer.
      const method = googleClient() ? undefined : await signInMethod(baseUrl).catch(() => undefined);
      try {
        const credential =
          method?.kind === 'code'
            ? await codeLogin(credentialStore(baseUrl), { baseUrl, openBrowser, say })
            : await login(credentialStore(baseUrl), {
                client:
                  googleClient() ??
                  (method?.kind === 'google' ? method.client : fail('BWAT_GOOGLE_CLIENT_ID is not set: login needs the Google client to sign in with')),
                openBrowser,
                say,
              });
        process.stdout.write(`signed in to ${baseUrl.href} as ${credential.email}\n`);
      } catch (err) {
        process.stderr.write(`${PLUGIN}: login failed: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'whoami': {
      const baseUrl = baseUrlOrFail() ?? fail('BWAT_BASE_URL is not set: whoami needs to know which bwat to ask about');
      const store = credentialStore(baseUrl);
      if (!store.load()) {
        process.stdout.write(`not signed in to ${baseUrl.href}; run ${PLUGIN} login\n`);
        process.exit(1);
      }
      const api = createApiClient({ baseUrl, token: () => freshIdToken(store) });
      try {
        const me = (await api.get(['me'])) as { email?: unknown; display_name?: unknown; role?: unknown };
        process.stdout.write(`signed in to ${baseUrl.href} as ${me.email} (${me.display_name}, ${me.role})\n`);
      } catch (err) {
        process.stderr.write(`${PLUGIN}: whoami failed: ${(err as Error).message}; run ${PLUGIN} login\n`);
        process.exitCode = 1;
      } finally {
        await api.close();
      }
      break;
    }
    case 'follow': {
      const baseUrl = baseUrlOrFail() ?? fail('BWAT_BASE_URL is not set: follow needs to know which bwat to read');
      if (!occurrence) fail('follow needs a meeting: follow <occurrence_id> [--every <seconds>] [--after <epoch>:<seq>]');
      const store = credentialStore(baseUrl);
      if (!store.load()) {
        process.stdout.write(`${HINTS.not_signed_in}\n`);
        process.exit(1);
      }
      const http = createApiClient({ baseUrl, token: () => freshIdToken(store) });
      try {
        await follow(bwatApi(http), occurrence, {
          everyMs: Number(parsed.values.every) * 1000,
          start: parsed.values.after?.split(':').map(Number) as Key | undefined,
          write: (line) => process.stdout.write(`${line}\n`),
        });
      } finally {
        await http.close();
      }
      break;
    }
    default:
      fail(`unknown command ${command ?? '(none)'}; usage: ${PLUGIN} serve [--client ${CLIENTS.join('|')}] | login | whoami | follow <occurrence_id> [--every <seconds>] [--after <epoch>:<seq>] [--base-url <url>] | --version`);
  }
}

void main();
