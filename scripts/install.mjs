// Installs the libraries package-lock.json names for scripts/start.mjs, when they are not installed
// yet. Claude Code installs them itself when it installs the plugin; for Codex and other clients the
// first start does. stdout is the MCP channel, so everything the install prints goes to stderr.
//
// Each install runs in a folder of its own inside the plugin and is moved into place in one rename
// once it has finished, so no start ever sees, or writes into, a node_modules another is building.
// Two first starts at once both install, and the second to finish uses the first one's.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The plugin's folder. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = /^\.install-(\d+)-[0-9a-f]+$/;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * The runtime libraries package-lock.json names that npm's record of the install does not list at
 * that version. Until an install has finished, all of them: npm writes node_modules/.package-lock.json
 * only once it has. This trusts that record; it does not check the files are still there.
 */
export function missing(root = ROOT) {
  const wanted = Object.entries(readJson(join(root, 'package-lock.json')).packages).filter(
    ([path, p]) => path.startsWith('node_modules/') && !p.dev && !p.devOptional && !p.optional,
  );
  let done = {};
  try {
    done = readJson(join(root, 'node_modules', '.package-lock.json')).packages;
  } catch {
    // No finished install.
  }
  return wanted.filter(([path, p]) => done[path]?.version !== p.version).map(([path]) => path.slice('node_modules/'.length));
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** Deletes a folder if it can: one an orphaned npm still holds open stays for a later start. */
const remove = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
};

/** Removes the install folders of starts that are no longer running, which a killed start leaves behind. */
export function sweep(root = ROOT) {
  for (const name of readdirSync(root)) {
    const pid = WORK.exec(name)?.[1];
    if (pid && Number(pid) !== process.pid && !alive(Number(pid))) remove(join(root, name));
  }
}

/** npm ci for the runtime libraries in `dir`, its output on stderr; resolves to whether it succeeded. */
function npmCi(dir) {
  // npm finds node on PATH, which can lack the node running this (a client started from a
  // desktop app, some shells): put that node's folder first. Windows spells the key Path.
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const env = { ...process.env, [key]: [dirname(process.execPath), process.env[key]].filter(Boolean).join(delimiter) };
  const child = spawn('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: dir, env, shell: true, stdio: ['ignore', 2, 2] });
  return new Promise((done) => {
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
  });
}

/**
 * Installs the runtime libraries, if any are missing, into a folder of its own, then moves them into
 * place. Returns why it could not, or undefined once they are in place (its own, or another start's).
 */
export async function install() {
  if (!missing().length) return undefined;
  const target = join(ROOT, 'node_modules');
  const work = join(ROOT, `.install-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    sweep();
    mkdirSync(work);
    for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(ROOT, file), join(work, file));
    process.stderr.write('bwat-plugin: installing its libraries (first start only)\n');
    if (!(await npmCi(work)) || missing(work).length) return 'npm ci failed (see above)';
    try {
      renameSync(join(work, 'node_modules'), target);
    } catch (err) {
      // Another start's install got there first. A node_modules this never builds in place (npm by
      // hand, an install cut short elsewhere) is left alone: replacing it could replace a finished one.
      // npm's record of a finished install is there when the plugin was updated in place over it.
      if (!missing().length) return undefined;
      if (!existsSync(target)) return `could not move the finished install into ${target} (${err.code})`;
      const state = existsSync(join(target, '.package-lock.json')) ? 'an older install' : 'unfinished';
      return `${target} is there but ${state} (${err.code}); delete it`;
    }
    return undefined;
  } catch (err) {
    return err.code ?? err.message;
  } finally {
    remove(work);
  }
}
