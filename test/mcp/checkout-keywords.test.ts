import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { normaliseKeywords, readCheckout } from '../../src/mcp/keywords.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bwat-checkout-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

// The checkout's words as the backend gets them, or none when there is no readable checkout.
const checkoutKeywords = (path: string) => readCheckout(path).then((found) => normaliseKeywords([found?.words ?? []]), () => []);

// A plain clone: .git is a folder holding HEAD.
function repo(name: string, head: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), head + '\n');
  return dir;
}

it('names the repository holding the file', async () => {
  const dir = repo('bwat-plugin', 'ref: refs/heads/develop');
  mkdirSync(join(dir, 'src', 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'src', 'mcp', 'session.ts'), '');
  expect(await checkoutKeywords(join(dir, 'src', 'mcp', 'session.ts'))).toEqual(['bwat-plugin']);
});

it('adds the ticket id and the words of the branch, without its prefix', async () => {
  const dir = repo('bwat-plugin', 'ref: refs/heads/feature/ABC-4844-session-keywords');
  expect(await checkoutKeywords(dir)).toEqual(['bwat-plugin', 'abc-4844', 'session', 'keywords']);
});

it.each(['developer', 'hotfix', 'release', 'chore'])('drops the %s/ prefix of a branch', async (prefix) => {
  expect(await checkoutKeywords(repo('bwat', `ref: refs/heads/${prefix}/ABC-7-gap`))).toEqual(['bwat', 'abc-7', 'gap']);
});

it('gives no branch words for main', async () => {
  expect(await checkoutKeywords(repo('bwat', 'ref: refs/heads/main'))).toEqual(['bwat']);
});

it('names the main repository and the worktree of a linked worktree', async () => {
  repo('bwat-plugin', 'ref: refs/heads/develop');
  const gitdir = join(root, 'bwat-plugin', '.git', 'worktrees', 'session-keywords');
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/bugfix/ABC-12-heartbeat-gap\n');
  const checkout = join(root, 'bwat-plugin-worktrees', 'session-keywords');
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, '.git'), `gitdir: ${gitdir}\n`);
  writeFileSync(join(checkout, 'README.md'), '');
  expect(await checkoutKeywords(join(checkout, 'README.md')))
    .toEqual(['bwat-plugin', 'session-keywords', 'abc-12', 'heartbeat', 'gap']);
});

it('gives nothing for an unreadable checkout', async () => {
  mkdirSync(join(root, 'broken', '.git'), { recursive: true });
  expect(await checkoutKeywords(join(root, 'broken'))).toEqual([]);
});

it('gives no branch for a detached HEAD', async () => {
  expect(await checkoutKeywords(repo('bwat', '4f2a9c1e0b7d3a6f8e5c2b1a9d0e7f6c5b4a3d2e'))).toEqual(['bwat']);
});

it('gives nothing outside a checkout', async () => {
  mkdirSync(join(root, 'loose'));
  expect(await checkoutKeywords(join(root, 'loose', 'notes.txt'))).toEqual([]);
});
