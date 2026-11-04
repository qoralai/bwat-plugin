import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sessionNameReader } from '../../src/mcp/session-name.js';

let home: string;
let dirs: { claude: string; codex: string };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bwat-names-'));
  dirs = { claude: join(home, 'claude'), codex: join(home, 'codex') };
  mkdirSync(join(dirs.claude, 'sessions'), { recursive: true });
  mkdirSync(dirs.codex);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const claude = (pid: number, sessionId: string, name: unknown) =>
  writeFileSync(join(dirs.claude, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, name }));
const codex = (id: string, thread_name: unknown) =>
  appendFileSync(join(dirs.codex, 'session_index.jsonl'), JSON.stringify({ id, thread_name }) + '\n');

it('reads the matching Claude name, follows renames and never adopts a reused process conversation', async () => {
  claude(101, 'other', 'Do not use');
  claude(102, 'session-one', 'Zoom invite');
  const name = sessionNameReader('claude-code', dirs);
  expect(await name('session-one')).toBe('Zoom invite');
  claude(102, 'session-one', 'Zoom meeting controls');
  expect(await name('session-one')).toBe('Zoom meeting controls');
  claude(102, 'new-conversation', 'Unrelated task');
  expect(await name('session-one')).toBeUndefined();
  claude(103, 'session-one', 'Resumed conversation');
  expect(await name('session-one')).toBe('Resumed conversation');
});

it('ignores malformed, oversized and contradictory Claude records and clears a removed name', async () => {
  const path = join(dirs.claude, 'sessions', '101.json');
  const name = sessionNameReader('claude-code', dirs);
  for (const text of ['{', 'null', JSON.stringify({ pid: 102, sessionId: 'session-one', name: 'wrong' }), ' '.repeat(17 * 1024)]) {
    writeFileSync(path, text);
    expect(await name('session-one')).toBeUndefined();
  }
  claude(101, 'session-one', 'Name');
  expect(await name('session-one')).toBe('Name');
  claude(101, 'session-one', '   ');
  expect(await name('session-one')).toBeUndefined();
});

it('uses the last complete Codex name for the exact thread id and notices append-only renames', async () => {
  const name = sessionNameReader('codex', dirs);
  codex('thread-one', 'First name');
  codex('thread-two', 'Another thread');
  expect(await name('thread-one')).toBe('First name');
  codex('thread-one', 'New name');
  appendFileSync(join(dirs.codex, 'session_index.jsonl'), 'malformed\n{"id":"thread-one","thread_name":"Partial');
  expect(await name('thread-one')).toBe('New name');
  expect(await name('thread-two')).toBe('Another thread');
  expect(await name('thread-unknown')).toBeUndefined();
});

it('ignores truncated leading records in a large Codex index and accepts later complete names', async () => {
  const path = join(dirs.codex, 'session_index.jsonl');
  writeFileSync(path, JSON.stringify({ id: 'thread-one', thread_name: 'Old name' }) + '\n' + 'x'.repeat(4 * 1024 * 1024));
  codex('thread-one', 'Partial leading line');
  codex('thread-one', 'Complete recent name');
  expect(await sessionNameReader('codex', dirs)('thread-one')).toBe('Complete recent name');
});

it.each(['claude-code', 'codex'] as const)('%s keeps Unicode titles within the backend limit and omits non-string names', async (kind) => {
  const store = (value: unknown) => kind === 'codex' ? codex('session-one', value) : claude(101, 'session-one', value);
  const name = sessionNameReader(kind, dirs);
  store('  Révision\n日本語  ');
  expect(await name('session-one')).toBe('Révision 日本語');
  store('a'.repeat(199) + '😀');
  expect(await name('session-one')).toBe('a'.repeat(199));
  store({ text: 'not a name' });
  expect(await name('session-one')).toBeUndefined();
});

it.each(['claude-code', 'codex'] as const)('%s missing metadata is harmless and uses no transcript fallback', async (kind) => {
  writeFileSync(join(home, 'conversation.jsonl'), JSON.stringify({ message: 'Must never become a title' }));
  expect(await sessionNameReader(kind, dirs)('missing-session')).toBeUndefined();
});
