/**
 * `follow`: print a live meeting's new transcript lines as they are said, one per line, for a
 * line-based reader such as Claude Code's Monitor tool. Polls the newest lines; never pages.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { BwatApi, Transcript } from './api/bwat.js';

const TAIL = 100;

/** A line's place in the transcript: epoch first, then seq. */
export type Key = [epoch: number, seq: number];
const keyOf = (s: Transcript['segments'][number]): Key => [s.epoch, s.seq];
const after = (a: Key, b: Key) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

/**
 * Reads every `everyMs` until the meeting is no longer live. Without `start`, the first read only
 * marks where the meeting is now. A failed read is reported and the next one tried.
 */
export async function follow(
  api: BwatApi,
  meeting: string,
  options: { everyMs: number; start?: Key; write: (line: string) => void },
): Promise<void> {
  let last = options.start;
  for (;;) {
    try {
      const transcript = await api.transcript(meeting, { tail: TAIL });
      const segments = transcript.segments.sort((a, b) => a.epoch - b.epoch || a.seq - b.seq);
      const fresh = last ? segments.filter((s) => after(keyOf(s), last!)) : [];
      // A chat message or a name can span lines; a line-based reader (which may also split on \r,
      // U+2028 or U+2029) needs each one on one, or an attendee could forge a line.
      // Each line leads with its cursor, so a reader can resume with --after from the last one it saw.
      for (const s of fresh) options.write(`[${s.epoch}:${s.seq}] ${s.speaker.label}: ${s.text}`.replace(/\s*[\r\n\u2028\u2029]\s*/g, ' '));
      const newest = segments.at(-1);
      last = (newest && keyOf(newest)) ?? last ?? [-1, -1];
      if (transcript.occurrence_state !== 'live') {
        options.write(`--- meeting ${transcript.occurrence_state}`);
        return;
      }
    } catch (err) {
      options.write(`(read failed: ${(err as Error).message})`);
    }
    await sleep(options.everyMs);
  }
}
