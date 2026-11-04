import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { derivedKeywords, normaliseKeywords, sessionKeywordsReader } from '../../src/mcp/keywords.js';

const checkout = join('/work', 'bwat-plugin');

it('lowercases the words', () => {
  expect(normaliseKeywords([['Bwat', 'Plugin']])).toEqual(['bwat', 'plugin']);
});

it('splits on anything but letters, digits, dots and hyphens', () => {
  expect(normaliseKeywords([['feature_flag', 'src/mcp', 'session.ts', 'Zoom invite']]))
    .toEqual(['feature', 'flag', 'src', 'mcp', 'session.ts', 'zoom', 'invite']);
});

it('keeps a hyphen inside a word, as in a ticket id or a repository name', () => {
  expect(normaliseKeywords([['ABC-4844', 'bwat-plugin']])).toEqual(['abc-4844', 'bwat-plugin']);
});

it('keeps only the words the backend accepts', () => {
  expect(normaliseKeywords([['a', '.claude', 'x'.repeat(33), 'x'.repeat(32), 'ok']])).toEqual(['x'.repeat(32), 'ok']);
});

it('keeps the first of each word, in group order', () => {
  expect(normaliseKeywords([['bwat', 'plugin'], ['Session', 'bwat'], ['session']])).toEqual(['bwat', 'plugin', 'session']);
});

it('keeps the first 24, so earlier groups win', () => {
  const structured = Array.from({ length: 20 }, (_, i) => `repo${i}`);
  const derived = Array.from({ length: 10 }, (_, i) => `word${i}`);
  expect(normaliseKeywords([structured, derived])).toEqual([...structured, 'word0', 'word1', 'word2', 'word3']);
});

it('derives the stem of an edited file', () => {
  expect(derivedKeywords([join(checkout, 'README.md')], [], checkout)).toEqual(['README']);
});

it('derives the folders between the checkout and each edited file, most recent file first', () => {
  const edited = [join(checkout, 'src', 'mcp', 'session.ts'), join(checkout, 'test', 'api', 'bwat.test.ts')];
  expect(derivedKeywords(edited, [], checkout)).toEqual(['src', 'mcp', 'session', 'test', 'api', 'bwat.test']);
});

it('derives no folders for an edited file outside the checkout, only its stem', () => {
  const edited = [join(checkout, 'src', 'session.ts'), join('/clients', 'acme', 'beta', 'x.ts')];
  expect(derivedKeywords(edited, [], checkout)).toEqual(['src', 'session', 'x']);
});

it.runIf(process.platform === 'win32')('derives no folders for an edited file on another drive', () => {
  expect(derivedKeywords(['C:\\clients\\acme\\x.ts'], [], 'J:\\work\\alpha')).toEqual(['x']);
});

it('adds the words of the typed prompts after the file words, skipping words under 3 letters', () => {
  expect(derivedKeywords([join(checkout, 'README.md')], ['heartbeat ui'], checkout)).toEqual(['README', 'heartbeat']);
});

it('drops stopwords from the prompts', () => {
  expect(derivedKeywords([], ['the heartbeat should not'])).toEqual(['heartbeat']);
});

it('orders prompt words most frequent first, then most recent, once each', () => {
  expect(derivedKeywords([], ['heartbeat keywords', 'transcript', 'heartbeat backend'])).toEqual(['heartbeat', 'backend', 'transcript', 'keywords']);
});

it('keeps at most 8 prompt words', () => {
  const prompt = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
  expect(derivedKeywords([], [prompt])).toEqual(['juliet', 'india', 'hotel', 'golf', 'foxtrot', 'echo', 'delta', 'charlie']);
});

it('drops a capitalised word that does not start a sentence, as a name', () => {
  expect(derivedKeywords([], ['Ask Priya about heartbeat. Rerun it for Tomas!\nDeploy'])).toEqual(['deploy', 'rerun', 'heartbeat', 'ask']);
});

describe('sessionKeywordsReader', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bwat-keywords-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // A plain clone, on develop unless told: then its folder name is its only structured word.
  function clone(name: string, branch = 'develop'): string {
    const dir = join(root, name);
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
    return dir;
  }

  it('keeps a session\'s checkout words after its checkout is deleted', async () => {
    const dir = clone('bwat-plugin', 'feature/ABC-12-heartbeat-gap');
    const transcript = async () => ({ edited: [join(dir, 'README.md')], prompts: [] });
    const read = sessionKeywordsReader(transcript, root);
    expect(await read('session-0001', 'Fix beat')).toEqual(['bwat-plugin', 'abc-12', 'heartbeat', 'gap', 'fix', 'beat', 'readme']);
    rmSync(dir, { recursive: true, force: true });
    expect(await read('session-0001', 'Fix beat')).toEqual(['bwat-plugin', 'abc-12', 'heartbeat', 'gap', 'fix', 'beat', 'readme']);
    expect(await read('session-0002', 'Fix beat')).toEqual(['fix', 'beat', 'readme']);
  });

  // Claude Code's own worktrees sit inside the main repository, so a deleted one must not read as the main checkout.
  it('keeps a nested worktree\'s words after it is deleted, rather than the main checkout\'s', async () => {
    const main = clone('bwat', 'feature/ABC-7-other-work');
    const wt = join(main, '.claude', 'worktrees', 'keywords');
    mkdirSync(join(main, '.git', 'worktrees', 'keywords'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'keywords', 'HEAD'), 'ref: refs/heads/feature/ABC-12-heartbeat-gap\n');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'keywords')}\n`);
    const transcript = async () => ({ edited: [join(wt, 'README.md')], prompts: [] });
    // The session runs in the main repository, as one that made the worktree does.
    const read = sessionKeywordsReader(transcript, main);
    expect(await read('session-0001')).toEqual(['bwat', 'keywords', 'abc-12', 'heartbeat', 'gap', 'readme']);
    rmSync(wt, { recursive: true, force: true });
    expect(await read('session-0001')).toEqual(['bwat', 'keywords', 'abc-12', 'heartbeat', 'gap', 'readme']);
  });

  // Codex runs the plugin's server from the plugin's own folder, so its checkout is not the project's:
  // the server gives it no transcript and no folder.
  it('reads a Codex session from its name only, never its folder or a transcript', async () => {
    const read = sessionKeywordsReader(async () => ({ edited: [], prompts: [] }));
    expect(await read('codex-thread-0001', 'Draft changelog')).toEqual(['draft', 'changelog']);
  });

  it('reads the checkout holding the most recent edit', async () => {
    const edited = [join(clone('alpha'), 'recent.ts'), join(clone('beta'), 'older.ts')];
    const read = sessionKeywordsReader(async () => ({ edited, prompts: [] }), root);
    expect((await read('session-0001'))?.[0]).toBe('alpha');
  });

  // Sessions write scratch, plan and memory files outside any checkout between edits to their project.
  it('reads the checkout of the most recent edit that has one, past a scratch file', async () => {
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const edited = [join(scratch, 'notes.md'), join(clone('alpha'), 'recent.ts')];
    const read = sessionKeywordsReader(async () => ({ edited, prompts: [] }));
    expect((await read('session-0001'))?.[0]).toBe('alpha');
  });

  it('reads the folder\'s checkout for a Claude Code session with no edits', async () => {
    const read = sessionKeywordsReader(async () => ({ edited: [], prompts: [] }), clone('bwat-plugin'));
    expect(await read('session-0001')).toEqual(['bwat-plugin']);
  });

  it('keeps the name and the work words when the checkout cannot be read', async () => {
    const broken = join(root, 'broken');
    mkdirSync(join(broken, '.git'), { recursive: true });
    const transcript = async () => ({ edited: [join(broken, 'README.md')], prompts: ['heartbeat'] });
    const read = sessionKeywordsReader(transcript, root);
    expect(await read('session-0001', 'Fix beat')).toEqual(['fix', 'beat', 'readme', 'heartbeat']);
  });

  it('gives undefined when nothing is found, so the last list is resent', async () => {
    const read = sessionKeywordsReader(async () => ({ edited: [], prompts: [] }), root);
    expect(await read('session-0001')).toBeUndefined();
  });
});
