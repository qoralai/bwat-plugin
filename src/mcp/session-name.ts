/**
 * Best-effort names from agent metadata only, never conversation messages.
 * The keyword reader (keywords.ts) does read the person's own typed prompts, by owner decision.
 */
import { open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionClient } from '../api/bwat.js';

const RECORD_BYTES = 16 * 1024;
const INDEX_BYTES = 4 * 1024 * 1024;

function title(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Fit the backend's 200 UTF-16-unit limit without cutting an emoji in half.
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200).replace(/[\uD800-\uDBFF]$/, '') || undefined;
}

export function parseSessionRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** Claude Code's own folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Finds a session's match among the entries of one of Claude's folders, checking at most 2048,
 * and remembers the entry that matched until it stops matching.
 */
export function claudeLocator<T>(
  dir: string,
  match: (entry: string, sessionId: string) => Promise<T | undefined>,
): (sessionId: string) => Promise<T | undefined> {
  let located: { id: string; entry: string } | undefined;
  return async (id) => {
    if (located?.id === id) {
      const found = await match(located.entry, id);
      if (found) return found;
    }
    located = undefined;
    let checked = 0;
    for await (const entry of await opendir(dir)) {
      if (++checked > 2048) break;
      const found = await match(entry.name, id);
      if (found) {
        located = { id, entry: entry.name };
        return found;
      }
    }
    return undefined;
  };
}

export async function readMetadata(path: string, limit: number, tail = false): Promise<string | undefined> {
  try {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (!tail && stat.size > limit)) return undefined;
      const start = Math.max(0, stat.size - limit);
      const buffer = Buffer.alloc(Math.min(stat.size, limit));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      // The first line may start outside this bounded tail. Never parse half a record.
      return start ? text.slice(text.indexOf('\n') + 1) : text;
    } finally { await file.close(); }
  } catch { return undefined; }
}

export function sessionNameReader(
  kind: SessionClient['kind'],
  dirs = {
    claude: claudeConfigDir(),
    codex: process.env.CODEX_HOME || join(homedir(), '.codex'),
  },
): (sessionId: string) => Promise<string | undefined> {
  // Claude's small sessions/<pid>.json records contain sessionId, pid and name.
  // A process can switch conversations, so never adopt a name by pid alone.
  const claudeRecord = claudeLocator(join(dirs.claude, 'sessions'), async (entry, id) => {
    if (!/^[1-9][0-9]*\.json$/.test(entry)) return undefined;
    const pid = Number(entry.slice(0, -5));
    const text = await readMetadata(join(dirs.claude, 'sessions', entry), RECORD_BYTES);
    const record = text === undefined ? undefined : parseSessionRecord(text);
    return record?.sessionId === id && (record.pid === undefined || record.pid === pid) ? record : undefined;
  });

  return async (id) => {
    try {
      if (kind === 'codex') {
        // Codex appends name updates; the last complete record for this exact id wins.
        // Cap local I/O: old names outside the tail retain the board's normal fallback.
        const text = await readMetadata(join(dirs.codex, 'session_index.jsonl'), INDEX_BYTES, true);
        if (text === undefined) return undefined;
        const lines = text.split('\n');
        lines.pop(); // A concurrent append may not have finished its last record yet.
        for (let i = lines.length - 1; i >= 0; i--) {
          const record = parseSessionRecord(lines[i]!);
          if (record?.id === id) return title(record.thread_name);
        }
        return undefined;
      }
      return title((await claudeRecord(id))?.name);
    } catch { /* Missing/changing metadata must not prevent registration or a heartbeat. */ }
    return undefined;
  };
}
