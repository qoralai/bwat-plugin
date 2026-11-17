import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The shipped bundle: every outside-in test drives this, never src/ directly. */
export const BUNDLE = fileURLToPath(new URL('../dist/bwat-plugin.js', import.meta.url));

/** Never the person's own ~/.bwat, with its sign-ins and saved address: an empty home unless a test sets one. */
const NO_HOME = { BWAT_HOME: join(tmpdir(), `bwat-no-home-${process.pid}`) };

/** Run one bundle command to completion. stdin is closed at once, so `serve` exits after starting. */
export function runBundle(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [BUNDLE, ...args], {
    encoding: 'utf8',
    input: '',
    timeout: 10_000,
    env: { ...process.env, ...NO_HOME, ...env },
  });
}

/** Run one bundle command without blocking this process, so a fake server here can answer it. */
export function runBundleAsync(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      env: { ...process.env, ...NO_HOME, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
