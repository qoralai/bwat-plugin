/** Session keywords, in the shape the backend keeps. */
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TranscriptWords } from './transcript.js';

// A word keeps its hyphens and dots (abc-123, bwat-plugin, session.ts); anything else splits.
const WORD = /[a-z0-9.-]+/g;
// The backend silently drops any keyword outside this pattern.
const KEYWORD = /^[a-z0-9][a-z0-9.-]{1,31}$/;
// ...and keeps only the first 24.
const MAX_KEYWORDS = 24;
// Branch prefixes that say nothing about the work.
const BRANCH_PREFIX = /^(feature|bugfix|hotfix|release|chore|developer)\//;
const TICKET = /[A-Za-z]+-[0-9]+/;
const MAX_PROMPT_WORDS = 8;
// Common English words that say nothing about the work.
const STOPWORDS = new Set(('the and for are but not you all any can had her was one our out has him his how its may new now old see two way who did get let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what which while would there their these those then into also could should about after again being does doing done each most other same where why yes okay please thanks').split(' '));

/** Groups come in priority order: the first copy of a word wins its place. */
export function normaliseKeywords(groups: string[][]): string[] {
  const words = groups.flat().flatMap((word) => word.toLowerCase().match(WORD) ?? []).filter((word) => KEYWORD.test(word));
  return [...new Set(words)].slice(0, MAX_KEYWORDS);
}

/**
 * A session's keywords, structured first: its checkout, its name, then the words of its own work.
 * Its checkout is the one holding the most recent edit inside a checkout, else the one holding cwd, if given.
 * Nothing found gives undefined.
 */
export function sessionKeywordsReader(
  readTranscript: (sessionId: string) => Promise<TranscriptWords>,
  cwd?: string,
): (sessionId: string, name?: string) => Promise<string[] | undefined> {
  // The session's last checkout words: a deleted worktree keeps the session's identity.
  let kept: { id: string; words: string[] } | undefined;
  return async (id, name) => {
    const { edited, prompts } = await readTranscript(id);
    const found = await firstCheckout([...edited.map((path) => dirname(path)), ...(cwd ? [cwd] : [])]);
    if (found?.words.length) kept = { id, words: found.words };
    const keywords = normaliseKeywords([kept?.id === id ? kept.words : [], name ? [name] : [], derivedKeywords(edited, prompts, found?.root)]);
    return keywords.length ? keywords : undefined;
  };
}

// The first folder's checkout, past folders outside any (scratch, plan and memory files). A folder
// that is gone ends the search, so a deleted worktree keeps its words instead of taking another's.
async function firstCheckout(folders: string[]): Promise<{ root: string; words: string[] } | undefined> {
  for (const folder of folders) {
    if (!await stat(folder).catch(() => undefined)) return undefined;
    const found = await readCheckout(folder).catch(() => undefined);
    if (found) return found;
  }
  return undefined;
}

/** The checkout holding a path, from its .git: repository, worktree, ticket and branch words (raw). */
export async function readCheckout(path: string): Promise<{ root: string; words: string[] } | undefined> {
  // A deleted worktree's folder is gone: walking up from it would find the repository around it instead.
  if (!await stat(path).catch(() => undefined)) return undefined;
  for (let dir = path; ; dir = dirname(dir)) {
    const git = await stat(join(dir, '.git')).catch(() => undefined);
    if (git) {
      // A linked worktree's .git file points at <main>/.git/worktrees/<name>.
      const linked = !git.isDirectory();
      const gitdir = linked ? resolve(dir, /^gitdir: (.+)$/m.exec(await readFile(join(dir, '.git'), 'utf8'))?.[1] ?? '') : join(dir, '.git');
      const main = linked ? [basename(dirname(dirname(dirname(gitdir))))] : [];
      return { root: dir, words: [...main, basename(dir), ...branchKeywords(await readFile(join(gitdir, 'HEAD'), 'utf8'))] };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

// HEAD names the branch; a detached HEAD holds a commit instead.
function branchKeywords(head: string): string[] {
  const branch = /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.replace(BRANCH_PREFIX, '') ?? '';
  if (branch === 'main' || branch === 'develop') return [];
  const ticket = TICKET.exec(branch)?.[0];
  const words = branch.replace(ticket ?? '', ' ').split(/[^A-Za-z0-9.]+/).filter(Boolean);
  return [...(ticket ? [ticket] : []), ...words];
}

/** Words of the session's own work (raw): edited files' folders and stems, most recent first, then its person's prompt words. */
export function derivedKeywords(edited: string[], prompts: string[], root?: string): string[] {
  const files = edited.flatMap((path) => [...folders(path, root), basename(path, extname(path))]);
  return [...files, ...promptWords(prompts)];
}

// The folders inside the checkout that hold the file; none without a checkout, or for a file outside it.
function folders(path: string, root?: string): string[] {
  if (!root) return [];
  const inside = relative(root, dirname(path));
  // Outside, the path climbs out of the checkout, or (on Windows) sits on another drive.
  if (inside.split(sep)[0] === '..' || isAbsolute(inside)) return [];
  return inside.split(sep).filter(Boolean);
}

// Prompts come oldest first, so a word's last position says how recently it was typed.
function promptWords(prompts: string[]): string[] {
  // A capitalised word that does not start a sentence is a person's name.
  const words = prompts.flatMap((prompt) => prompt.split(/[.!?]\s+|\n+/))
    .flatMap((sentence) => (sentence.match(/[A-Za-z]+/g) ?? []).filter((word, i) => i === 0 || !/^[A-Z]/.test(word)))
    .map((word) => word.toLowerCase()).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  const seen = new Map<string, { count: number; last: number }>();
  words.forEach((word, last) => seen.set(word, { count: (seen.get(word)?.count ?? 0) + 1, last }));
  return [...seen].sort(([, a], [, b]) => b.count - a.count || b.last - a.last).map(([word]) => word).slice(0, MAX_PROMPT_WORDS);
}
