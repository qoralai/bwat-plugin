import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

/**
 * Packaging: each host's manifest must start the same bundle with that host's --client.
 *
 * How each host finds the bundle (verified, not assumed):
 * - Claude Code expands ${CLAUDE_PLUGIN_ROOT} and ${user_config.KEY} in MCP server config.
 * - Codex (0.156.1 probe) expands no placeholder in a plugin's MCP config; it resolves a relative
 *   "cwd" against the installed plugin root. With both manifests present it reads only
 *   .codex-plugin and the server file that names.
 * Each host gets its own server file, so neither reads the other's, and no root .mcp.json exists
 * to be picked up as a project MCP config by contributors.
 */
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const json = (path: string) => JSON.parse(readFileSync(join(REPO, path), 'utf8'));
const PKG = json('package.json') as { version: string };

interface StdioEntry {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

const HOSTS: { host: string; manifest: string; client: string; vars: Record<string, string> }[] = [
  {
    host: 'Claude Code',
    manifest: '.claude-plugin/plugin.json',
    client: 'claude-code',
    // What Claude Code substitutes; the base URL is whatever the user set when enabling the plugin.
    vars: { '${CLAUDE_PLUGIN_ROOT}': REPO, '${user_config.base_url}': 'https://bwat.example/v1' },
  },
  { host: 'Codex', manifest: '.codex-plugin/plugin.json', client: 'codex', vars: {} },
];

const expand = (value: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((out, [from, to]) => out.replaceAll(from, to), value);

function bwatEntry(manifest: string): { file: string; entry: StdioEntry } {
  const file = (json(manifest) as { mcpServers: string }).mcpServers;
  const entry = (json(file) as { mcpServers: Record<string, StdioEntry> }).mcpServers.bwat;
  if (!entry) throw new Error(`${file} declares no bwat server`);
  return { file, entry };
}

describe.each(HOSTS)('$host packaging', ({ manifest, client, vars }) => {
  const plugin = json(manifest) as { name: string; version: string };
  const { file, entry } = bwatEntry(manifest);
  const cwd = entry.cwd === undefined ? REPO : join(REPO, entry.cwd);
  const args = entry.args.map((a) => expand(a, vars));

  it('names the plugin bwat at the package version', () => {
    expect(plugin).toMatchObject({ name: 'bwat', version: PKG.version });
  });

  it(`runs the bundle under node with --client ${client}`, () => {
    expect(entry.command).toBe('node');
    expect(args.slice(1)).toEqual(['serve', '--client', client]);
    expect(existsSync(resolve(cwd, args[0]!))).toBe(true);
  });

  it('uses only placeholders this host expands', () => {
    const used = JSON.stringify(entry).match(/\$\{[^}]*\}/g) ?? [];
    expect(used.filter((p) => !(p in vars))).toEqual([]);
    expect(file).not.toBe('./.mcp.json');
  });

  it('starts an MCP server named bwat when launched as the host would', async () => {
    const env = Object.fromEntries(Object.entries(entry.env ?? {}).map(([k, v]) => [k, expand(v, vars)]));
    const mcp = new Client({ name: 'manifest-test', version: '0.0.0' });
    await mcp.connect(
      new StdioClientTransport({ command: process.execPath, args, cwd, env: { ...getDefaultEnvironment(), ...env }, stderr: 'pipe' }),
    );
    try {
      expect(mcp.getServerVersion()?.name).toBe('bwat');
    } finally {
      await mcp.close();
    }
  });
});

describe('the two plugin manifests', () => {
  it('describe the same plugin', () => {
    const claude = json('.claude-plugin/plugin.json') as Record<string, unknown>;
    const codex = json('.codex-plugin/plugin.json') as Record<string, unknown>;
    for (const key of ['name', 'version', 'description', 'author', 'repository', 'keywords'])
      expect({ [key]: codex[key] }).toEqual({ [key]: claude[key] });
  });
});

describe('Claude Code install settings', () => {
  // Revisit in the login chunk: once `bwat-plugin login` can store a base URL, decide which source wins.
  it('asks for the bwat base URL when the plugin is enabled, required and with no default', () => {
    const { userConfig } = json('.claude-plugin/plugin.json') as { userConfig: Record<string, Record<string, unknown>> };
    expect(Object.keys(userConfig)).toEqual(['base_url']);
    expect(userConfig.base_url).toMatchObject({ type: 'string', required: true });
    expect(userConfig.base_url).not.toHaveProperty('default');
    expect(bwatEntry('.claude-plugin/plugin.json').entry.env).toEqual({ BWAT_BASE_URL: '${user_config.base_url}' });
  });
});

describe('the version files cz bump writes', () => {
  // cz.toml: the npm provider writes package.json and package-lock.json, version_files the two manifests.
  const FILES = ['package.json', 'package-lock.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];

  it('all carry the package version', () => {
    const lock = json('package-lock.json') as { version: string; packages: Record<string, { version: string }> };
    const versions = [lock.version, lock.packages['']!.version, ...FILES.slice(2).map((f) => (json(f) as { version: string }).version)];
    expect(versions).toEqual(versions.map(() => PKG.version));
  });

  // On Windows cz writes CRLF, and the mixed-line-ending hook then fails the bump commit.
  it.each(FILES)('%s has LF line endings only', (file) => {
    expect(readFileSync(join(REPO, file), 'utf8')).not.toContain('\r');
  });
});
