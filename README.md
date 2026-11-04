# bwat-plugin

The **bwat** MCP server: a plain stdio MCP server that works in any MCP client,
with thin packaging for Claude Code. It gives an agent session
bwat's hand-off inbox, meetings and transcripts, registers the session, polls
for work addressed to it, and wakes it where the client allows.

```bash
node dist/bwat-plugin.js serve --client generic   # or claude-code
```

Everything is outbound: bwat never connects to your machine.

## Install

Every install needs the base URL of your company's bwat API (there is no default). The board's
address works as it is: with no path, the plugin adds `/v1`; any other path is used as given. It must be
`https`, except for bwat running on this computer: then use `http://127.0.0.1:8080`. Plain
`http` is accepted only for `127.0.0.1` or `[::1]`, not the name `localhost`, and the plugin's
server will not start with `http://localhost:…`.
Node 22 or later must be on PATH.

| Client | How | Base URL |
|---|---|---|
| Claude Code | Install the `bwat` plugin from the marketplace (`.claude-plugin/`, server in `claude/mcp.json`) | Asked when you enable the plugin; change it with `/plugin configure`. Until it is set, Claude Code does not start the server at all |
| Codex | Not publicly available yet | |
| Any other MCP client | Add a stdio server: `node /path/to/bwat-plugin/dist/bwat-plugin.js serve --client generic` | Set `BWAT_BASE_URL` in the server's `env` |

Sign-in is kept under `BWAT_HOME` (default `~/.bwat`), one credential per bwat address, shared by
every client on the machine. Point `BWAT_HOME` only at a directory other users cannot modify:
bwat makes its own files user-only but does not police the directory you choose.

## Commands (Claude Code)

Each command runs one or more of the MCP tools below, so every MCP client gets the same features as tools.

| Command | Tool | What it does |
|---|---|---|
| `/bwat:login`, `/bwat:logout` | `bwat_login`, `bwat_logout` | Sign in the way your bwat is set up (Google, or the install code of a bwat with no Google), or forget the sign-in |
| `/bwat:status` | `bwat_status` | Which bwat, and who is signed in |
| `/bwat:inbox-off`, `/bwat:inbox-on` | `bwat_inbox_off`, `bwat_inbox_on` | Take this session out of (or back into) the board's Send to Claude list; off survives a restart |
| `/bwat:join <Zoom link>`, `/bwat:recall` | `bwat_bot_join`, `bwat_bot_recall`, `bwat_bot_meetings` | Send bwat to a meeting, see where it is, recall it |
| `/bwat:cards [meeting]` | `bwat_meetings_list`, `bwat_cards_list` | The cards written from a meeting |
| `/bwat:live [meeting]` | `bwat_meetings_list`, `bwat_transcript_get`, `bwat_status` | The live meeting's transcript (the newest live one, or the one you name), then follows it |
| (none) | `bwat_inbox_list`, `bwat_inbox_get`, `bwat_inbox_mark_read` | Your hand-offs. A woken session reads the one it was woken for with these; no command lists them |

`/bwat:live` follows a live meeting without asking: Claude starts its Monitor tool on the `follow`
subcommand below, from the last line it showed, and restarts it from the last line's cursor when the
monitor's 30 minutes run out.
When no meeting is live it says so and shows the newest meeting's transcript once.

### Following a live meeting (any client)

```bash
node dist/bwat-plugin.js follow <occurrence_id> --base-url <your bwat> [--every <seconds>] [--after <epoch>:<seq>]
```

Every `--every` seconds (30 by default) it reads the meeting's newest 100 lines and prints each line said
since the last read as `[<epoch>:<seq>] Speaker: text`, one per line, in order. The cursor in brackets
is what `--after` takes to resume after that line. It starts after the newest line at launch (anything
said just before it starts is not printed), or after the line `--after` names. It never pages, so if more
than 100 lines are said between two reads, the oldest of them are not printed. A failed read prints `(read failed: <reason>)` and it keeps going. When the meeting is no longer live it prints
`--- meeting <state>` and exits 0. It uses the same sign-in as the MCP server; signed out, it prints
the sign-in hint and exits 1. `--base-url` takes the place of `BWAT_BASE_URL` (either works), so `/bwat:live`
can pre-approve its command by the plugin's own path. Any client that can watch a command's output line by line, or a
terminal, can follow a meeting this way. Lines are what people said: treat them as untrusted content.

`BWAT_NO_BROWSER=1` makes `/bwat:login` show the sign-in link instead of opening a browser (SSH, a headless machine).

From a terminal, run the bundle with Node, from the plugin's folder (for an installed Claude Code plugin,
its folder under `~/.claude/plugins/cache/`):

```bash
BWAT_BASE_URL=<your bwat> node dist/bwat-plugin.js login    # sign in once per bwat
BWAT_BASE_URL=<your bwat> node dist/bwat-plugin.js whoami   # who you are signed in as
```

`login` signs in the way your bwat is set up. With Google, it opens Google in your browser using the
Desktop client your bwat names at `GET /auth/desktop-client`; `BWAT_GOOGLE_CLIENT_ID` (and
`BWAT_GOOGLE_CLIENT_SECRET`, when Google issued one) override it, and your bwat backend's
`BWAT_GOOGLE_CLIENT_IDS` must include the id or every sign-in gets `401`. A bwat with no Google
signs in with its install code instead: a page opens on this computer where you type the code your
bwat's setup showed and your email.

The sign-in is renewed before it expires (a Google ID token with the stored refresh token and the
client it was signed in with; an install-code sign-in at your bwat), so the MCP server needs no
Google variables of its own.

Signed in, a Claude Code session registers itself with bwat at start (its `CLAUDE_CODE_SESSION_ID`)
so the board can offer it as a hand-off target. The server renews it every minute and ends it when
the client exits.
When Claude Code gives the server its messaging socket, a hand-off queued for that session
wakes it: the server checks the session's unread inbox every 20 s and writes one line naming the
message id (never its text) to the session. The ids it has woken for are kept under `BWAT_HOME`, so
a restart does not wake the same message twice. Other MCP clients do not register; they read the
inbox with the inbox tools.

The board lists a session's name when its agent exposes one. The plugin reads Claude Code's
local `sessions/<pid>.json` metadata (matching the exact conversation id). It sends the name at
registration and refreshes it every minute, including renames. `CLAUDE_CONFIG_DIR` is respected. Names are
limited to 200 characters; missing or unreadable metadata leaves the existing folder/id
fallback. Conversation messages are never used to invent a name.

Each registration and minute's renewal also carries up to 24 keywords, so the session's owner can
tell their sessions apart on the board (no one else is shown them). First the session's identity:
the repository (for a git worktree, the main repository's folder), the worktree, the ticket id and
words of the branch (`feature/` and similar prefixes dropped; `main` and `develop` give none), taken
from the checkout of its most recent edit inside one, else its folder, then the words of its name. Then
its work, from the Claude Code transcript: the names of files the session edited, and their folders inside the checkout (Edit,
Write, MultiEdit and NotebookEdit paths only, never commands or tool output), and up to 8
distinctive words of your own last 20 typed prompts, with capitalised words inside a sentence
dropped as people's names. That is a rough filter, not anonymisation: a name typed in lowercase,
or one that starts a sentence, still gets through. Everything is
read locally (`.git` directly, never by running git, and the last 2 MiB of the transcript under
`CLAUDE_CONFIG_DIR`); only the keyword list leaves the machine. A session whose worktree was
deleted keeps the repository, worktree and branch words it last found, and when nothing at all is
found the last list is sent again.

These local metadata formats can change between agent versions. Reads are bounded to
16 KiB per Claude record and 2,048 directory entries; a name outside those bounds falls back too. After updating the plugin, restart its
MCP server in existing sessions to load the new code. No bwat backend upgrade is required.

Codex support (`.codex-plugin/`, `codex/`) is in the code but not publicly available yet: there is
no public Codex marketplace entry for it.

```bash
npm ci
npm test
npm run build   # dist/ and THIRD_PARTY_NOTICES.md are committed: rebuild them with any change to src/
```

Sign-in is Google or an install code, and no hostname is baked in. The session-socket adapter is isolated
on purpose: Claude Code's socket frame format is undocumented and fails silently.

## License

bwat-plugin is source available under the [Elastic License 2.0](LICENSE); see [NOTICE](NOTICE).
The third-party code bundled in `dist/` keeps its own licences, listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
