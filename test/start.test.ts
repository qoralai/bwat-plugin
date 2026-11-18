import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs script, no types
import { missing, sweep } from '../scripts/install.mjs';
import { runBundleAsync } from './bundle.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

/**
 * A folder whose package-lock.json names these packages, with node_modules holding the installed
 * versions, and npm's record of a finished install unless `finished` is false.
 */
function fixture(locked: Record<string, Record<string, unknown>>, installed: Record<string, string>, finished = true) {
  const dir = mkdtempSync(join(tmpdir(), 'bwat-start-'));
  const lock = (entries: [string, unknown][]) => JSON.stringify({ packages: Object.fromEntries(entries.map(([n, p]) => [`node_modules/${n}`, p])) });
  writeFileSync(join(dir, 'package-lock.json'), lock(Object.entries(locked)));
  for (const [name, version] of Object.entries(installed)) {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
  if (finished) writeFileSync(join(dir, 'node_modules', '.package-lock.json'), lock(Object.entries(installed).map(([n, version]) => [n, { version }])));
  return dir;
}

/** The id of a process that has exited. */
function deadPid() {
  const run = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(run.stdout);
}

/** A copy of what the plugin ships with no libraries installed, as a first start finds it. */
function freshCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'bwat-first-start-'));
  for (const f of ['package.json', 'package-lock.json', 'scripts/install.mjs', 'scripts/start.mjs', 'src']) cpSync(join(REPO, f), join(dir, f), { recursive: true });
  return dir;
}

/** `--version` from the copy of the plugin in `dir`, given time for a first start's install. */
const start = (dir: string) => runBundleAsync(['--version'], {}, { launcher: join(dir, 'scripts', 'start.mjs'), timeout: 170_000 });

describe('scripts/start.mjs and scripts/install.mjs', () => {
  it('names each runtime library that is absent or at another version, and nothing a dev or optional install brings', () => {
    const dir = fixture(
      {
        here: { version: '1.0.0' },
        stale: { version: '2.0.0' },
        absent: { version: '1.0.0' },
        '@scope/nested': { version: '3.0.0' },
        tool: { version: '1.0.0', dev: true },
        both: { version: '1.0.0', devOptional: true },
        native: { version: '1.0.0', optional: true },
      },
      { here: '1.0.0', stale: '1.9.0', '@scope/nested': '3.0.0' },
    );
    try {
      expect(missing(dir)).toEqual(['stale', 'absent']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // npm writes its record of the install last, so files from an install that was cut short do not count.
  it('counts every library as missing until npm has recorded a finished install', () => {
    const dir = fixture({ here: { version: '1.0.0' } }, { here: '1.0.0' }, false);
    try {
      expect(missing(dir)).toEqual(['here']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds nothing missing in this checkout, so tests and a configured start never reinstall', () => {
    expect(missing(REPO)).toEqual([]);
  });

  it('removes the install folders a killed start left, and not those of a running one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwat-sweep-'));
    const dead = deadPid();
    try {
      for (const name of [`.install-${dead}-0a1b`, `.install-${process.pid}-0a1b`, `.install-${dead}-x`, 'node_modules'])
        mkdirSync(join(dir, name, 'node_modules'), { recursive: true });
      sweep(dir);
      expect(readdirSync(dir).sort()).toEqual([`.install-${dead}-x`, `.install-${process.pid}-0a1b`, 'node_modules'].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Two sessions starting at once: both start, every word of the install goes to stderr, and
  // stdout (the MCP channel) carries only what bwat itself prints.
  it.concurrent('starts two first starts that race, without writing to stdout, leaving one finished install', async () => {
    const dir = freshCopy();
    try {
      const runs = await Promise.all([start(dir), start(dir)]);
      for (const run of runs) expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 0, stdout: `${VERSION}\n` });
      expect(runs.some((r) => r.stderr.includes('installing its libraries'))).toBe(true);
      expect(missing(dir)).toEqual([]);
      expect(readdirSync(dir).filter((f) => f.startsWith('.install-'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  // What a start killed mid-install leaves: its own install folder, never a half-built node_modules.
  it.concurrent('starts after a killed start left its install folder', async () => {
    const dir = freshCopy();
    try {
      mkdirSync(join(dir, `.install-${deadPid()}-0a1b`, 'node_modules', 'zod'), { recursive: true });
      const run = await start(dir);
      expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 0, stdout: `${VERSION}\n` });
      expect(missing(dir)).toEqual([]);
      expect(readdirSync(dir).filter((f) => f.startsWith('.install-'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  // A node_modules this launcher did not build (npm by hand, an install cut short elsewhere) is
  // never moved: replacing one could replace another start's finished install.
  it.concurrent('leaves an unfinished node_modules it did not build in place, and says to delete it', async () => {
    const dir = freshCopy();
    try {
      mkdirSync(join(dir, 'node_modules', 'zod'), { recursive: true });
      const run = await start(dir);
      expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 2, stdout: '' });
      expect(run.stderr).toContain(`${join(dir, 'node_modules')} is there but unfinished`);
      expect(readdirSync(join(dir, 'node_modules'))).toEqual(['zod']);
      expect(readdirSync(dir).filter((f) => f.startsWith('.install-'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  // A plugin folder reached through a link (a linked checkout, macOS's /tmp) still starts.
  it('starts through a linked plugin folder', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'bwat-linked-'));
    const link = join(parent, 'plugin');
    try {
      symlinkSync(REPO, link, 'junction');
      const run = await start(link);
      expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 0, stdout: `${VERSION}\n` });
    } finally {
      rmSync(link, { force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // A folder updated in place over a finished install of other versions says so.
  it.concurrent('says an older install is in the way when the libraries in node_modules are at other versions', async () => {
    const dir = freshCopy();
    try {
      mkdirSync(join(dir, 'node_modules', 'zod'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: {} }));
      const run = await start(dir);
      expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 2, stdout: '' });
      expect(run.stderr).toContain(`${join(dir, 'node_modules')} is there but an older install`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
