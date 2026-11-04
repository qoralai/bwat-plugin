/** Best-effort reads of a Claude Code transcript: the files the session edited and the person's typed prompts. */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeConfigDir, claudeLocator, parseSessionRecord, readMetadata } from './session-name.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PROMPTS = 20;
const TAIL_BYTES = 2 * 1024 * 1024;

export interface TranscriptWords { edited: string[]; prompts: string[] }

// The fields read here, in the shapes Claude Code writes them; this is not checked at runtime.
interface TranscriptRecord {
  type?: unknown;
  isMeta?: unknown;
  origin?: { kind?: unknown };
  message: { content: unknown };
}

interface ToolUse { type: string; name: string; input: { file_path?: string; notebook_path?: string } }

export function transcriptReader(dir = claudeConfigDir()): (sessionId: string) => Promise<TranscriptWords> {
  // The project folder is named after a cwd we cannot know, so look in each one.
  const locate = claudeLocator(join(dir, 'projects'), async (entry, id) => {
    const file = join(dir, 'projects', entry, `${id}.jsonl`);
    return stat(file).then(() => file, () => undefined);
  });

  return async (id) => {
    try {
      const edited: string[] = [];
      const prompts: string[] = [];
      const file = await locate(id);
      // Transcripts grow without bound; recent work is at the end.
      const text = (file && await readMetadata(file, TAIL_BYTES, true)) ?? '';
      for (const line of text.split('\n')) {
        const record = parseSessionRecord(line) as TranscriptRecord | undefined;
        if (!record) continue;
        // Only a person's own typing: hook feedback is meta, and notifications, peers and command output have other origins.
        if (record.type === 'user' && record.isMeta !== true && record.origin?.kind === 'human') prompts.push(promptText(record.message.content));
        if (record.type !== 'assistant') continue;
        for (const block of record.message.content as ToolUse[]) {
          if (block.type === 'tool_use' && EDIT_TOOLS.has(block.name)) edited.push((block.input.file_path ?? block.input.notebook_path)!);
        }
      }
      return { edited: [...new Set(edited.reverse())], prompts: prompts.slice(-PROMPTS) };
    } catch {
      // A missing or unexpected transcript must not cost a heartbeat.
      return { edited: [], prompts: [] };
    }
  };
}

// A prompt is a string, or blocks whose text blocks hold what was typed.
function promptText(content: unknown): string {
  if (typeof content === 'string') return content;
  return (content as { type: string; text: string }[]).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}
