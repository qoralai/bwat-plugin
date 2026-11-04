import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startWaking, wakeLine } from '../../src/mcp/wake.js';

// In-process, against a local socket standing in for Claude Code's.
const ID_1 = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const ID_2 = '0b9e8d7c-6b5a-4f39-8a27-160514f3e2d1';
const path =
  process.platform === 'win32' ? `\\\\.\\pipe\\bwat-wake-${process.pid}-${Date.now()}` : join(tmpdir(), `bwat-wake-${process.pid}-${Date.now()}.sock`);
const socket = { path, token: 't' };
let dir: string;
let server: Server;
let writes: number;

const inboxOf = (id: string) => ({ inbox: async () => ({ messages: [{ id }] }) }) as never;
const settle = () => new Promise((r) => setTimeout(r, 200));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bwat-wake-'));
  writes = 0;
  server = createServer((conn) => {
    conn.on('data', () => undefined);
    conn.on('end', () => writes++);
  });
  await new Promise<void>((r) => server.listen(path, r));
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

it('keeps each session\'s woken ids apart, so two sessions on one machine never overwrite each other', async () => {
  const a = startWaking(inboxOf(ID_1), 'session-aaaa', socket, dir);
  const b = startWaking(inboxOf(ID_2), 'session-bbbb', socket, dir);
  await settle();
  a.stop();
  b.stop();
  expect(writes).toBe(2);
  expect(readdirSync(dir).filter((f) => f.startsWith('woken')).sort()).toEqual(['woken-session-aaaa.json', 'woken-session-bbbb.json']);
});

it('wakes nothing once stopped, even for a poll that was already waiting on bwat', async () => {
  let answer!: () => void;
  const slow = { inbox: () => new Promise((r) => (answer = () => r({ messages: [{ id: ID_1 }] }))) } as never;
  const waking = startWaking(slow, 'session-aaaa', socket, dir);
  waking.stop();
  answer();
  await settle();
  expect(writes).toBe(0);
});

it('starts no poll while the last one is still running, so one message is never woken twice', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    let calls = 0;
    let answer!: () => void;
    const slow = { inbox: () => (calls++, new Promise((r) => (answer = () => r({ messages: [] }))) ) } as never;
    const waking = startWaking(slow, 'session-aaaa', socket, dir);
    vi.advanceTimersByTime(60_000);
    expect(calls).toBe(1);
    answer();
    await settle();
    vi.advanceTimersByTime(20_000);
    expect(calls).toBe(2);
    waking.stop();
  } finally {
    vi.useRealTimers();
  }
});

it('treats an unreadable woken file as empty instead of never waking the session again', async () => {
  writeFileSync(join(dir, 'woken-session-aaaa.json'), '{"not": "a list"');
  const waking = startWaking(inboxOf(ID_1), 'session-aaaa', socket, dir);
  await settle();
  waking.stop();
  expect(writes).toBe(1);
});

it('says a hand-off came from the bwat board, not another Claude session, and how to handle it', () => {
  const line = wakeLine(ID_1);
  expect(line.startsWith('From the bwat board, not another Claude session:')).toBe(true);
  expect(line).toContain(`inbox message ${ID_1}`);
  expect(line).toMatch(/queued, not started/);
  expect(line).toMatch(/bwat_inbox_get.*untrusted.*bwat_inbox_mark_read/);
});
