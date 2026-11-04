import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { transcriptReader } from '../../src/mcp/transcript.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bwat-transcript-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

// Claude Code keeps each conversation at projects/<folder named after the cwd>/<sessionId>.jsonl.
function transcript(records: object[], folder = 'J--work-shop', sessionId = 'session-one'): void {
  mkdirSync(join(home, 'projects', folder), { recursive: true });
  writeFileSync(join(home, 'projects', folder, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r) + '\n').join(''));
}
const tool = (name: string, input: object) => ({
  type: 'assistant', sessionId: 'session-one', cwd: '/work/shop', gitBranch: 'develop',
  message: { content: [{ type: 'tool_use', id: 'toolu_1', name, input }] },
});

it('lists the file a Write call edited', async () => {
  transcript([tool('Write', { file_path: '/work/shop/src/cart.ts', content: 'export {}' })]);
  expect(await transcriptReader(home)('session-one')).toEqual({ edited: ['/work/shop/src/cart.ts'], prompts: [] });
});

it('finds the transcript in whichever project folder holds it', async () => {
  transcript([tool('Write', { file_path: '/elsewhere/a.ts' })], 'J--elsewhere', 'session-two');
  transcript([tool('Write', { file_path: '/work/shop/b.ts' })], 'C--Users-me-work', 'session-one');
  expect((await transcriptReader(home)('session-one')).edited).toEqual(['/work/shop/b.ts']);
});

it('lists only files that edit tools touched, never reads, commands or results', async () => {
  transcript([
    tool('Read', { file_path: '/work/shop/read-only.ts' }),
    tool('Bash', { command: 'cat /work/shop/ran.ts', description: 'Show a file' }),
    tool('Edit', { file_path: '/work/shop/edited.ts', old_string: 'a', new_string: 'b' }),
    { type: 'user', origin: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '/work/shop/output.ts' }] } },
    tool('MultiEdit', { file_path: '/work/shop/multi.ts', edits: [] }),
    tool('NotebookEdit', { notebook_path: '/work/shop/notes.ipynb', new_source: '' }),
  ]);
  expect((await transcriptReader(home)('session-one')).edited)
    .toEqual(['/work/shop/notes.ipynb', '/work/shop/multi.ts', '/work/shop/edited.ts']);
});

it('lists each edited file once, at its most recent edit', async () => {
  transcript([
    tool('Write', { file_path: '/work/shop/a.ts' }),
    tool('Write', { file_path: '/work/shop/b.ts' }),
    tool('Edit', { file_path: '/work/shop/a.ts' }),
  ]);
  expect((await transcriptReader(home)('session-one')).edited).toEqual(['/work/shop/a.ts', '/work/shop/b.ts']);
});

const typed = (content: unknown) => ({
  type: 'user', sessionId: 'session-one', promptSource: 'typed', origin: { kind: 'human' }, message: { role: 'user', content },
});

it('lists the prompts the person typed', async () => {
  transcript([typed('fix the cart total'), tool('Write', { file_path: '/work/shop/cart.ts' }), typed('now add tax')]);
  expect((await transcriptReader(home)('session-one')).prompts).toEqual(['fix the cart total', 'now add tax']);
});

it('reads a prompt typed as text blocks', async () => {
  transcript([typed([{ type: 'text', text: 'look at this screenshot' }, { type: 'image', source: {} }, { type: 'text', text: 'the badge overlaps' }])]);
  expect((await transcriptReader(home)('session-one')).prompts).toEqual(['look at this screenshot\nthe badge overlaps']);
});

it('skips hook feedback, task notifications, peer messages, command output and tool results', async () => {
  transcript([
    { ...typed('Stop hook feedback: run the tests'), isMeta: true },
    { ...typed('<task-notification>agent finished</task-notification>'), origin: { kind: 'task-notification' }, promptSource: 'system' },
    { ...typed('<peer-message>ship it</peer-message>'), origin: { kind: 'peer', from: 'other-session' } },
    { ...typed('<bash-stdout>secret output</bash-stdout>'), origin: null },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }] } },
    typed('only this was typed'),
  ]);
  expect((await transcriptReader(home)('session-one')).prompts).toEqual(['only this was typed']);
});

it('keeps the last 20 typed prompts, oldest first', async () => {
  transcript(Array.from({ length: 25 }, (_, i) => typed(`prompt ${i}`)));
  expect((await transcriptReader(home)('session-one')).prompts).toEqual(Array.from({ length: 20 }, (_, i) => `prompt ${i + 5}`));
});

it('skips lines that are not complete records', async () => {
  transcript([typed('before')]);
  appendFileSync(join(home, 'projects', 'J--work-shop', 'session-one.jsonl'), 'not json\n' + JSON.stringify(typed('after')) + '\n{"type":"user","mess');
  expect((await transcriptReader(home)('session-one')).prompts).toEqual(['before', 'after']);
});

it('reads only the last 2 MB and never the cut record at its start', async () => {
  // The tail starts exactly at a record's opening brace, so only dropping the cut line stops it being read.
  const cut = JSON.stringify(typed('cut at the tail start'));
  const late = (pad: string) => JSON.stringify({ ...typed('late'), pad });
  const fill = 2 * 1024 * 1024 - cut.length - late('').length - 2;
  transcript([typed('early')]);
  appendFileSync(join(home, 'projects', 'J--work-shop', 'session-one.jsonl'), 'x'.repeat(100) + cut + '\n' + late('p'.repeat(fill)) + '\n');
  expect((await transcriptReader(home)('session-one')).prompts).toEqual(['late']);
});

it('gives nothing, without throwing, when there is no transcript', async () => {
  expect(await transcriptReader(home)('session-one')).toEqual({ edited: [], prompts: [] });
  transcript([typed('another conversation')], 'J--work-shop', 'session-two');
  expect(await transcriptReader(home)('session-one')).toEqual({ edited: [], prompts: [] });
});

it('gives nothing, without throwing, for records of an unexpected shape', async () => {
  transcript([{ type: 'assistant', message: { content: 'text' } }, { type: 'user', origin: { kind: 'human' }, message: {} }]);
  expect(await transcriptReader(home)('session-one')).toEqual({ edited: [], prompts: [] });
});

it('keeps reading the transcript it found, and looks again once that one is gone', async () => {
  transcript([typed('found first')], 'M--found');
  const read = transcriptReader(home);
  expect((await read('session-one')).prompts).toEqual(['found first']);
  // Folders are scanned in no fixed order; a remembered path does not depend on it.
  transcript([typed('copy elsewhere')], 'A--elsewhere');
  expect((await read('session-one')).prompts).toEqual(['found first']);
  rmSync(join(home, 'projects', 'M--found'), { recursive: true });
  expect((await read('session-one')).prompts).toEqual(['copy elsewhere']);
});
