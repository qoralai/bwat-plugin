/**
 * Keeps this server's agent session registered with bwat, so the board can offer it as a
 * hand-off target: a PUT on bind, one a minute after that (bwat stops offering a session it has
 * not heard from in 180 s), and ended: true on shutdown. The instance id is new per process.
 * A failed beat is not retried early: the next one a minute later is the retry. Requests go one
 * at a time, in order, so a beat still in flight can never land after the end.
 */
import { randomUUID } from 'node:crypto';
import type { BwatApi, SessionClient } from '../api/bwat.js';

const HEARTBEAT_MS = 60_000;

export function sessionRouter(
  api: Pick<BwatApi, 'putSession'>,
  client: SessionClient,
  nameFor?: (sessionId: string) => Promise<string | undefined>,
  keywordsFor?: (sessionId: string, name?: string) => Promise<string[] | undefined>,
) {
  const instance_id = randomUUID();
  let id: string | undefined;
  let beat: NodeJS.Timeout | undefined;
  let last: Promise<unknown> = Promise.resolve();
  let keywords: string[] | undefined;
  const put = (ended: boolean) => {
    const sessionId = id!;
    last = last.catch(() => undefined).then(async () => {
      // Capture the id above, before queueing: a later bind must not lend this request its name.
      const name = ended ? undefined : await nameFor?.(sessionId).catch(() => undefined);
      // An empty or failed read resends the last list: a deleted worktree keeps the session's identity.
      const found = ended ? undefined : await keywordsFor?.(sessionId, name).catch(() => undefined);
      // Only the bound session's read is kept: a beat still running for an earlier id sends its own list.
      if (found?.length && sessionId === id) keywords = found;
      const list = found?.length ? found : sessionId === id ? keywords : undefined;
      const descriptor = { ...(nameFor ? { ...client, name } : client), ...(!ended && list && { keywords: list }) };
      return api.putSession(sessionId, { client: descriptor, instance_id, ended });
    });
    return last;
  };

  return {
    /** Register this session id, and heartbeat it from now on instead of any earlier one. */
    async bind(sessionId: string): Promise<void> {
      // A new id's kept keywords were the previous session's (a /clear starts a new one); the same
      // id is rebound on every prompt and keeps them.
      if (sessionId !== id) keywords = undefined;
      id = sessionId;
      clearInterval(beat);
      beat = setInterval(() => void put(false).catch(() => undefined), HEARTBEAT_MS).unref();
      await put(false);
    },
    /** Tell bwat the session is gone. Best effort: the process is exiting either way. */
    async end(): Promise<void> {
      clearInterval(beat);
      if (id) await put(true).catch(() => undefined);
    },
  };
}

export type SessionRouter = ReturnType<typeof sessionRouter>;
