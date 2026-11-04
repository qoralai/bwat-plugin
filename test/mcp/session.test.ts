import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionRouter } from '../../src/mcp/session.js';
import type { SessionClient } from '../../src/api/bwat.js';

// In-process, on fake time: the heartbeat is a minute apart, too slow for the bundle tests.
const CLIENT = { kind: 'codex', wake: 'pull', machine: 'm', platform: 'p', plugin_version: '0.1.0', cwd: 'repo' } as const;
let sent: { id: string; ended: boolean; instance_id: string }[];
const api = { putSession: async (id: string, body: { ended: boolean; instance_id: string }) => void sent.push({ id, ...body }) };

beforeEach(() => {
  sent = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it('heartbeats the bound session every 60 s, keeps one instance id, and stops on end', async () => {
  const router = sessionRouter(api, CLIENT);
  await router.bind('thread-0001');
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  expect(sent.map((s) => [s.id, s.ended])).toEqual([['thread-0001', false], ['thread-0001', false], ['thread-0001', false]]);
  await router.end();
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(sent.map((s) => [s.id, s.ended]).slice(3)).toEqual([['thread-0001', true]]);
  expect(new Set(sent.map((s) => s.instance_id)).size).toBe(1);
});

it('a later bind moves the heartbeat to the new session', async () => {
  const router = sessionRouter(api, CLIENT);
  await router.bind('thread-0001');
  await router.bind('thread-0002');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent.map((s) => s.id)).toEqual(['thread-0001', 'thread-0002', 'thread-0002']);
});

it('ends nothing when no session was ever bound', async () => {
  await sessionRouter(api, CLIENT).end();
  expect(sent).toEqual([]);
});

it('ends a session without waiting for another metadata lookup', async () => {
  const name = vi.fn().mockResolvedValue('Session name');
  const router = sessionRouter(api, CLIENT, name);
  await router.bind('thread-one');
  await router.end();
  expect(name).toHaveBeenCalledTimes(1);
  expect(sent.at(-1)).toMatchObject({ id: 'thread-one', ended: true });
});

it('refreshes names each heartbeat and keeps registration working when metadata is unavailable', async () => {
  const bodies: SessionClient[] = [];
  const name = vi.fn().mockResolvedValueOnce('Initial name').mockResolvedValueOnce('Renamed').mockRejectedValueOnce(new Error('missing metadata'));
  const router = sessionRouter({ putSession: async (_id, body) => { bodies.push(body.client); } }, CLIENT, name);
  await router.bind('thread-one');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(bodies.map(b => b.name)).toEqual(['Initial name', 'Renamed', undefined]);
  expect(bodies.every(b => b.cwd === 'repo')).toBe(true);
  await router.end();
});

it('resolves the captured session id when a rebind happens during a queued request', async () => {
  const applied: [string, string | undefined][] = [];
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const name = vi.fn(async (id: string) => { if (id === 'thread-one') await first; return id + ' name'; });
  const router = sessionRouter({ putSession: async (id, body) => { applied.push([id, body.client.name]); } }, CLIENT, name);
  const one = router.bind('thread-one');
  const two = router.bind('thread-two');
  release();
  await Promise.all([one, two]);
  expect(applied).toEqual([['thread-one', 'thread-one name'], ['thread-two', 'thread-two name']]);
  await router.end();
});

it('an end sent while a beat is still in flight reaches bwat after it', async () => {
  const applied: boolean[] = [];
  let release!: () => void;
  const slow = {
    putSession: (_id: string, body: { ended: boolean }) =>
      body.ended
        ? Promise.resolve(void applied.push(true))
        : new Promise<void>((r) => (release = () => r(void applied.push(false)))),
  };
  const router = sessionRouter(slow, CLIENT);
  const bound = router.bind('thread-0001');
  const ended = router.end();
  await vi.advanceTimersByTimeAsync(0); // let the beat's request start
  release();
  await Promise.all([bound, ended]);
  expect(applied).toEqual([false, true]);
});

it('sends the session keywords on bind and every beat, and none with the end', async () => {
  const bodies: SessionClient[] = [];
  const keywords = vi.fn().mockResolvedValueOnce(['bwat-plugin', 'keywords']).mockResolvedValueOnce(['bwat-plugin', 'session']);
  const router = sessionRouter({ putSession: async (_id, body) => { bodies.push(body.client); } }, CLIENT, undefined, keywords);
  await router.bind('thread-one');
  await vi.advanceTimersByTimeAsync(60_000);
  await router.end();
  expect(bodies.map(b => b.keywords)).toEqual([['bwat-plugin', 'keywords'], ['bwat-plugin', 'session'], undefined]);
  expect(keywords).toHaveBeenCalledTimes(2);
});

it('resends the last keywords when a beat finds none, and sends no keywords field before any are found', async () => {
  const bodies: SessionClient[] = [];
  const keywords = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(['bwat-plugin'])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('worktree deleted'));
  const router = sessionRouter({ putSession: async (_id, body) => { bodies.push(body.client); } }, CLIENT, undefined, keywords);
  await router.bind('thread-one');
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  expect(bodies[0]).not.toHaveProperty('keywords');
  expect(bodies.slice(1).map(b => b.keywords)).toEqual([['bwat-plugin'], ['bwat-plugin'], ['bwat-plugin'], ['bwat-plugin']]);
  await router.end();
});

it('a new session id starts with no kept keywords, so it never sends the previous session\'s list', async () => {
  const bodies: [string, SessionClient][] = [];
  const keywords = vi.fn().mockResolvedValueOnce(['bwat-plugin']).mockResolvedValueOnce(undefined);
  const router = sessionRouter({ putSession: async (id, body) => { bodies.push([id, body.client]); } }, CLIENT, undefined, keywords);
  await router.bind('thread-one');
  await router.bind('thread-two');
  expect(bodies.map(([id, client]) => [id, client.keywords])).toEqual([['thread-one', ['bwat-plugin']], ['thread-two', undefined]]);
  await router.end();
});

it('a rebind of the same session id keeps its keywords, as hooks rebind on every prompt', async () => {
  const bodies: SessionClient[] = [];
  const keywords = vi.fn().mockResolvedValueOnce(['bwat-plugin']).mockResolvedValueOnce(undefined);
  const router = sessionRouter({ putSession: async (_id, body) => { bodies.push(body.client); } }, CLIENT, undefined, keywords);
  await router.bind('thread-one');
  await router.bind('thread-one');
  expect(bodies.map(b => b.keywords)).toEqual([['bwat-plugin'], ['bwat-plugin']]);
  await router.end();
});

it('overlapping binds of different ids never send one session\'s keywords for the other', async () => {
  const bodies: [string, string[] | undefined][] = [];
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const keywords = vi.fn(async (id: string) => { if (id !== 'thread-one') return undefined; await first; return ['one-words']; });
  const router = sessionRouter({ putSession: async (id, body) => { bodies.push([id, body.client.keywords]); } }, CLIENT, undefined, keywords);
  const one = router.bind('thread-one');
  const two = router.bind('thread-two');
  release();
  await Promise.all([one, two]);
  expect(bodies).toEqual([['thread-one', ['one-words']], ['thread-two', undefined]]);
  await router.end();
});

// Codex binds whichever of its threads the person last used, so binds can go one, two, one.
it('a beat for an earlier id that finds nothing never sends the bound session\'s keywords', async () => {
  const bodies: [string, string[] | undefined][] = [];
  const keywords = vi.fn(async (id: string) => (id === 'thread-one' ? ['one-words'] : undefined));
  const router = sessionRouter({ putSession: async (id, body) => { bodies.push([id, body.client.keywords]); } }, CLIENT, undefined, keywords);
  await Promise.all([router.bind('thread-one'), router.bind('thread-two'), router.bind('thread-one')]);
  expect(bodies).toEqual([['thread-one', ['one-words']], ['thread-two', undefined], ['thread-one', ['one-words']]]);
  await router.end();
});
