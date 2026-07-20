# Claude Telegram Bot

[한국어](./README.ko.md) · **English**

[![npm version](https://img.shields.io/npm/v/claude-telegram-bot.svg)](https://www.npmjs.com/package/claude-telegram-bot)
[![npm downloads](https://img.shields.io/npm/dm/claude-telegram-bot.svg)](https://www.npmjs.com/package/claude-telegram-bot)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Use Claude Code or Codex from Telegram — run coding agents anywhere, from any device.

**A zero-dependency, daemonized Telegram bridge for Claude Code and Codex — no Bun, no Python, no open session.**

A small bridge that takes your Telegram messages, runs the selected coding provider in a project
folder, and sends the result back to the chat. It uses only Node 18+ built-ins, with no runtime
dependencies to install.

```text
[you] → Telegram → bot.mjs
                     ├─ Claude provider → state.sessionId
                     ├─ Codex provider  → state.codexSessionId
                     └─ Ollama mode/fallback
                              ↓
                  result → Telegram

Claude limit → Codex fallback → codex-handoff.md → next Claude call
```

Drive a coding agent from your phone: run tests, edit files, commit, push — all from a chat.
It runs as a **background daemon** (launchd), so there's no interactive session to keep open.

> ### ⚠️ This is a remote code-execution tool by design. Read the [Security](#security) section before running it.
> A message you send from Telegram is executed as a command on the machine running the bot.
> With `permissionMode: bypassPermissions`, a one-line message can run **anything** as your user.

## 3-minute quick start

Prerequisites: **Node.js 18+**, the **Claude Code `claude` CLI installed and authenticated**, and a Telegram bot token from `@BotFather`.

```sh
npm i -g claude-telegram-bot
claude-telegram-bot init ~/botconfigs/my-project
```

Edit `~/botconfigs/my-project/mybot.json`:

```json
{
  "token": "BOT_TOKEN_FROM_BOTFATHER",
  "allowedChatId": "",
  "projectDir": "/ABSOLUTE/PATH/TO/PROJECT",
  "claudeBin": "/ABSOLUTE/PATH/TO/claude",
  "permissionMode": "acceptEdits"
}
```

Start once to discover your chat ID:

```sh
claude-telegram-bot ~/botconfigs/my-project/mybot.json
```

Send any message to the Telegram bot. It replies with your `chatId`. Put that value into `allowedChatId`, restart the bot, then send something useful:

```text
run the tests and summarize any failures
```

For a no-install trial, use `npx claude-telegram-bot init` and `npx claude-telegram-bot` instead. To
run Codex instead of (or alongside) Claude, see [Configuration](#configuration).

## Why this exists

Sometimes you are away from your desk but still want to ask a coding agent to inspect a repo, run
tests, make a small edit, or prepare a commit. Remote desktop and SSH are heavy for that; a Telegram
chat is enough.

This project is intentionally small: a CLI/daemon that reuses the `claude` and/or `codex` CLI already
authenticated on your machine. It is best for a Mac mini, home server, dev box, or personal VPS that
you already trust.

**Highlights**

- **Zero dependencies** — just Node 18+. No npm install, no supply chain.
- **Multi-project** — one codebase drives many projects via per-project config files.
- **Multi-persona** — split the *same* project into role-based bots (e.g. Developer + Planner)
  with per-bot system prompts and **differentiated permission levels**.
- **Session continuity** — conversations resume across restarts (`--resume`); `/new` to reset.
- **Provider switching** — use Claude or Codex as the main agent and switch with `/provider`.
- **Fallback handoff** — Codex can take over when Claude hits a limit and leave handoff notes.
- **Attachments** — send photos/docs/voice/video; they're saved locally and handed to the active provider.
- **Always-on** — ships with a launchd template for macOS (auto-start, auto-restart).

## How it compares

This space is crowded, and Anthropic now ships an official solution. Here's an honest map so you
can pick the right tool:

| | This bot | [Official Claude Code Channels](https://code.claude.com/docs/en/channels) | [claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) |
|---|---|---|---|
| Runtime | **Node built-ins only** | Bun + MCP plugin | Python 3.11+ + libs |
| Execution model | headless Claude or Codex process per message | events pushed into an **open** `claude --channels` session | Claude SDK / CLI |
| Stays running as | **background daemon** (no session open) | a live interactive session you keep running | service / daemon |
| Multi-persona, permission-scoped bots on one repo | **yes** (dev=`bypass`, planner=`plan`) | no | no |
| Per-action permission approval (inline buttons) | no (set `permissionMode`) | **yes** | partial |
| Feature breadth (webhooks, cron, voice, export) | minimal | medium | **large** |
| Runtime dependencies | **none (Node built-ins)** | plugin runtime | Python packages |

**Use the official Channels** if you want per-action approvals and don't mind keeping a session
open. **Use claude-code-telegram** if you want maximum features. **Use this** if you want a
minimal, auditable, zero-dependency daemon — and especially if you want **role-split persona bots**
with different permission levels on the same project.

---

## Security

**Treat this tool like an SSH key into your machine that lives in a chat app.** It is designed
to execute commands; that power is the point, and also the risk. Read this before exposing it.

### Threat model — who can run commands on your machine

1. **The allowed chat.** Anyone with access to the Telegram account whose `chatId` you allow can
   run commands. Lock your phone and Telegram account (2FA).
2. **Whoever holds the bot token.** The token is the bot's password. With it, an attacker can read
   incoming messages and impersonate the bot. The `allowedChatId` whitelist still blocks command
   *execution* (Telegram-supplied `chatId`s can't be forged), but **treat a leaked token as an
   incident**: revoke it via `@BotFather` → `/revoke` and issue a new one.
3. **Prompt-injected content.** If you forward a webpage, file, or repo issue and ask the bot to act
   on it, malicious instructions inside that content can steer Claude. Don't pipe untrusted content
   into a `bypassPermissions` bot.

### Non-negotiables

- **Always set `allowedChatId`.** Until you do, the bot refuses to run anything and just replies
  with the chat's ID. Once set, only that chat can issue commands — this is your only auth layer,
  so it must be set.
- **Guard the token like a credential.** `config.json` and `state.json` are in `.gitignore` so you
  don't commit it — keep it that way. Never paste the token into issues, logs, or screenshots. The
  startup log redacts it (`token: <redacted>`); don't add it back.
- **The bot itself is not a security boundary.** Provider controls reduce risk but do not isolate
  Telegram, custom commands, or the daemon process. Claude runs with `permissionMode`; Codex uses
  `codexSandbox`. Both processes still inherit the daemon user's environment and credentials.

### Choose the least permission you can live with

Claude and Codex use different safety controls. Switching provider can therefore change the
effective permission boundary.

For Claude, `permissionMode` is the main safety dial:

| Mode | What it allows | Use when |
|---|---|---|
| `plan` | Read & plan only, no edits | Q&A, code review, a "planner" persona |
| `acceptEdits` | Auto-approve file edits; other actions (shell, etc.) still gated | **Recommended default** — useful but bounded |
| `bypassPermissions` | Everything auto-runs, **including arbitrary shell** | You accept that one chat message = arbitrary code execution |

Practical hardening:

- Prefer `acceptEdits` over `bypassPermissions` unless you specifically need autonomous shell/git.
- Point `projectDir` at a **specific project**, not your home directory — limit the blast radius.
- For multi-persona setups, give only **one** bot `bypassPermissions`; keep the rest on `plan`.
- Consider running on a dedicated user account or VM if you'll leave it always-on.
- For Codex, keep `codexSandbox: "workspace-write"` unless you understand the implications of a
  broader sandbox setting. `/plan`, `/compact`, and automatic compact are currently Claude-only.
- Custom `/commands` run directly as the daemon user; neither `permissionMode` nor `codexSandbox`
  restricts them.

### Reporting a vulnerability

Found a security issue? Please open a GitHub issue (or contact the maintainer privately for
sensitive reports) rather than posting exploit details publicly.

---

## Install & run

This is a standalone CLI/daemon, **not a library** — you don't `import` it. Install it globally (or
run via `npx`), point a config file at any project, and run it. `projectDir` in the config decides
which folder Claude works in, independent of where the bot is installed.

Prerequisites: **Node 18+**, a Telegram bot token, and at least one configured provider. Install and
authenticate the **Claude CLI** for Claude, the **Codex CLI** for Codex or Codex fallback, and
**Ollama plus a local model** only if you enable Ollama mode/fallback.

**Option A — npx (no install)**

```sh
npx claude-telegram-bot init             # writes ./mybot.json
npx claude-telegram-bot init myapp.json  # or pick your own filename
# edit the config (token, projectDir, …)
npx claude-telegram-bot                  # runs ./mybot.json (falls back to config.json)
```

**Option B — global install (recommended for an always-on daemon)**

```sh
npm i -g claude-telegram-bot

claude-telegram-bot init ~/botconfigs/myproj             # writes ~/botconfigs/myproj/mybot.json
claude-telegram-bot init ~/botconfigs/myproj/myapp.json  # or a custom filename
# edit the config (token, projectDir, …)
claude-telegram-bot ~/botconfigs/myproj/mybot.json
```

Run several projects/personas by making one config file each and passing its path —
`state.json` and `attachments/` live next to that config, so they don't mix.

> **Keep your config out of git.** The config file holds your bot token. If you drop one inside a git
> repo, add it (plus `state*.json` and `attachments/`) to *that* project's `.gitignore`. This repo
> already ignores `config.json`, `config.*.json`, `*.config.json`, `state*.json`, and `attachments/`,
> so any name like `claudebot.config.json` is covered here — but your own project won't ignore them
> until you say so.

### First-run steps

**1) Create a bot token** — In Telegram, open `@BotFather` → `/newbot` → pick a name and a
`username` ending in `_bot` → copy the token (looks like `123456789:AA...`). Put it in `config.json`,
leave `allowedChatId` empty for now.

**2) Find your chatId and lock the bot to it** — Start the bot (`claude-telegram-bot …`), send it any
message in Telegram; it replies with this chat's `chatId`. Put that number into `mybot.json`
`allowedChatId` and restart. Now only you can use it. (See [Security](#security) — this is your only
auth layer.)

**3) Use it** — just send messages:

- `run the solver tests and commit + push if they pass`
- `add an edge case to solve-2nd-floor-edges.ts`

Core commands:

| Command | Purpose |
|---|---|
| `/provider [claude\|codex\|default]` | View or switch the Telegram bot's provider override |
| `/model [name\|default]` | View or switch the active provider's model; suggestions are provider-specific |
| `/new` | Reset the active provider's conversation session |
| `/plan <request>` | Produce a plan and wait for approval (Claude only) |
| `/compact` | Compact the current context (Claude only) |
| `/stop [--reset]` | Stop the task; optionally restore its previous session ID |
| `/ollama` | Toggle local Ollama chat mode |
| `/testfallback` | Test the configured Codex or Ollama fallback |
| `/status` | Show version, provider, CLI versions, model, fallback, and session state |
| `/remember <text>` · `/memory` | Save or inspect persistent memory |
| `/cron` · `/reserve` | Manage scheduled jobs and usage-limit retries |
| `/autocompact` · `/restart` · `/id` · `/help` | Maintenance and help commands |

> **`/plan <request>`** runs the request in read-only plan mode (no edits, no shell) regardless of
> the bot's configured `permissionMode`, and replies with the plan plus **✅ Proceed / ❌ Cancel**
> buttons. Tapping **Proceed** resumes the same session with the bot's normal `permissionMode` and
> tells Claude to implement the approved plan; **Cancel** leaves the session untouched. This gives
> you a review step before a `bypassPermissions` bot touches anything. The pending approval expires
> if you start a new session with `/new` first.

> **`/stop`** kills the provider process running **in that room** and clears that room's queued
> messages. Other rooms keep running untouched. Add `--reset` to also restore the session to the
> state it was in *before* the task started, so the conversation history doesn't include the
> interrupted work.

> **`/restart`** runs `node --check` on `bot.mjs` first and **aborts the restart if it has a syntax
> error** (so a bad edit can't crash-loop the bot), then exits — relying on a process supervisor
> to relaunch it. Works out of the box with the [launchd setup](#always-on-with-launchd-macos)
> (`KeepAlive`); under a bare `node bot.mjs` with no supervisor it just stops. Your session resumes
> after the restart (the id lives in `state.json`). Unlike `/stop`, a restart is **not** room-scoped —
> it takes the whole process down, so any task running in another room dies with it. Rooms that had a
> task running or messages queued get told; idle rooms aren't bothered.

**4) Keep it always on (optional)** — see [Always-on with launchd](#always-on-with-launchd-macos).

> **From source** (for hacking on the bot): clone the repo, `cp config.example.json mybot.json`,
> then `node bot.mjs [mybot.json]`. Same behavior as the CLI.

---

## Compatibility

The bot depends on CLI flags and machine-readable output that may change between releases. These are
the development-environment versions recorded as the compatibility baseline on 2026-07-10; they are
reference versions, not strict pins or a claim that every path passes. Use `/status` to see the
versions actually installed on the bot host.

| CLI | Recorded version | Relevant integration |
|---|---:|---|
| Claude Code | `2.1.206` | JSON output, session resume, permission mode |
| Codex CLI | `0.144.1` | `exec`, `exec resume`, JSONL events, workspace sandbox |
| Ollama | `0.31.1` | `ollama launch claude`, model selection, session handoff |

When upgrading one of these CLIs, run `/testfallback` and a normal Claude message before relying on
the bot unattended. Update this table after recording the new environment and checking those paths.

## Configuration

```sh
cp config.example.json mybot.json
```

Edit `mybot.json`:

| Key | Description |
|---|---|
| `token` | Bot token from BotFather |
| `allowedChatId` | **Leave empty at first** → the bot tells you (step 3). Required before it runs anything. |
| `projectDir` | Absolute path to the working folder the selected provider runs in |
| `provider` | (optional) Main provider for Telegram messages and scheduled jobs: `"claude"` (default) or `"codex"` |
| `claudeBin` | Output of `which claude` (absolute path recommended) |
| `permissionMode` | Claude-only: `plan` / `acceptEdits` / `bypassPermissions` — see [Security](#security) |
| `model` | Claude model. Empty = CLI default. Override with `/model` while Claude is active. |
| `lang` | (optional) UI language. Empty = auto-detect per user (English default, Korean for Korean Telegram clients). Force with `"en"` / `"ko"`. |
| `name` | (optional) Bot name shown in `/help` — handy for telling multiple bots apart |
| `persona` | (optional) Role system prompt — defines a persona (developer/planner/…). See below |
| `appendSystemPrompt` | (optional) Override the default "be concise for Telegram" instruction |
| `env` | (optional) Extra environment variables passed to provider processes |
| `schedule` | (optional) Cron jobs that run a prompt on a timer — see [Scheduled tasks](#scheduled-tasks-cron) |
| `commands` | (optional) Custom `/commands` that run shell scripts — see [Custom commands](#custom-commands) |
| `codexFallback` | (optional) `true` to enable Codex as the preferred fallback when Claude is rate-limited or out of credits |
| `codexBin` | (optional) Path to the `codex` binary. Defaults to `"codex"` on `PATH`; use an absolute path for launchd |
| `codexModel` | (optional) Codex model passed with `--model`; override while Codex is active with `/model <full-id>` |
| `codexSandbox` | (optional) Codex sandbox for a new `codex exec` session (default: `"workspace-write"`) |
| `codexTimeout` | (optional) Milliseconds to wait for Codex before falling back to reserve/Ollama (default: `600000`) |
| `ollamaFallback` | (optional) `true` to enable Ollama as a secondary fallback when Claude is rate-limited or out of credits |
| `ollamaModel` | (optional) Ollama model to use for fallback (default: `"qwen3.5:4b"`). The context a session carries over is capped by this model's runtime context window (`num_ctx`), which Ollama defaults to ~4K regardless of the model's architectural max — too small for a long Claude session. Bake a larger window into a variant with a `Modelfile` (`FROM qwen3.5:4b` + `PARAMETER num_ctx 6144`, `ollama create qwen3.5:4b-ctx6k -f Modelfile`) and point this at it. Size it to your RAM — on an 8 GB machine ~6K is the safe ceiling; 32K swaps the machine to death. |
| `ollamaBin` | (optional) Path to the `ollama` binary. Auto-detected at `/opt/homebrew/bin/ollama`, `/usr/local/bin/ollama`, `/usr/bin/ollama`, falling back to `"ollama"` on `PATH` — set this explicitly if your install lives elsewhere, since a launchd-run bot doesn't inherit your shell's `PATH` |
| `ollamaTimeout` | (optional) Milliseconds to wait for an Ollama reply before giving up (default: `360000` — local models can be slow to cold-start) |
| `autoCompactThreshold` | (optional) Auto-compact context when cached input tokens exceed this value (default: `100000`). Set to `0` to disable. Override at runtime with `/autocompact` (persists in state). |

The same config also drives local interactive sessions. `ctb mybot.json` uses `config.provider`,
while an explicit flag overrides it for that invocation:

```sh
ctb mybot.json --provider claude
ctb mybot.json --provider codex
ctb mybot.json --chat -1001234567890   # resume a specific room's session
```

Sessions are stored per room at `state.sessions[chatId]` — Claude under `sessionId`, Codex under
`codexSessionId` (resumed with `codex resume <session-id>`). `ctb` resumes the first entry of
`allowedChatId` (usually your DM) unless `--chat <id>` names another room. The sessions remain
separate. The `/plan` approval workflow currently
requires `provider: "claude"`; normal messages, attachments, and scheduled jobs support both.

`/provider` stores a Telegram-only override in state, survives bot restarts, and does not rewrite
the config. The local `ctb` command intentionally continues to use `config.provider` or its explicit
`--provider` flag.

State and downloaded attachments live in a hidden **`.claude-bot/`** folder next to the config
file, so projects stay isolated. Upgrading from an older version **auto-moves** an existing
`state.json` / `attachments/` into `.claude-bot/` on first start (no data loss). Logs stay wherever
your launchd plist points them.

### Usage details

- **Concise mode**: a `--append-system-prompt` is applied by default so replies stay short for
  Telegram. Override it via `appendSystemPrompt` (empty string disables it).
- **Language**: the bot's own messages (`/help`, command menu, status text) are English by default
  and switch to Korean for users whose Telegram client is Korean. Force one language with `lang`
  (`"en"`/`"ko"`). Claude's actual replies follow the language you write in, regardless. The `/`
  command menu is registered per-language via `setMyCommands`.
- **Formatting**: the reply's Markdown (bold/code/headings/tables) is converted to Telegram-safe
  HTML. If conversion ever produces invalid HTML, the message is automatically resent as plain text.
- **Attachments**: send a photo/document/voice/video and it's downloaded into `attachments/`; the
  absolute path is handed to the active provider (caption included as the message).
- **Sessions**: Claude and Codex keep separate session IDs, so switching providers preserves both
  conversations. `/new` resets only the active provider's session.
- **Per-chat sessions**: your DM and each group hold independent Claude/Codex sessions (`state.sessions[chatId]`); what you say in one room never carries into another room's session. Settings like `provider` and `model` are bot-wide.
- **Group chats**: to use the bot in a group, make it a **group admin**. Telegram's privacy mode limits a non-admin bot to mentions, commands, and replies, but an admin bot receives every message so you can talk to it without @mentioning it each time (alternatively, disable privacy mode via BotFather `/setprivacy`). Everyone in the group shares that group's single session. Commands also work in the `/command@BotName` form Telegram appends in groups; a `/command@SomeOtherBot` addressed to a different bot is ignored.
- **Per-room concurrency**: rooms run **in parallel** — a long task in your DM doesn't block a group, and vice versa. Each room holds its own session, so there's nothing to serialize across them. Within a single room, messages still run one at a time (queued and merged, below). Scheduled jobs get their own slot: they serialize against each other but run alongside your rooms. A local `ctb` terminal session is still a machine-wide lock and pauses every room.
- **Message queue**: if you send a message while that room's task is running, it is queued (not dropped). When the task finishes, queued messages **from the same room** are merged into a single prompt so Claude can resolve corrections and follow-ups in one pass (e.g. "do X" then "never mind, do Y" → handled together). Merging is only ever within a room, so it can't mix sessions. Use `/stop` to cancel that room's running task and discard its queue.
- **Models**: `/model` follows the active provider and stores separate Claude/Codex overrides. Claude shows the `haiku`, `sonnet`, `opus`, and `fable` aliases; Codex asks for a full Codex model ID instead of displaying Claude aliases. `/model default` clears only the active provider's override.
- **Usage-limit queue**: when a Claude Max / API rate-limit error includes a reset time, the bot first tries enabled fallbacks. If no fallback is enabled or every fallback fails, the triggering message is queued and retried at that time — just like messages queued while Claude is busy. Any additional messages you send during the limit window are also added to the queue. Use `/reserve` to check queue status and reset time, `/reserve rm` to cancel and clear the queue.
- **Codex fallback**: set `"codexFallback": true` to run `codex exec` when Claude is rate-limited or out of credits. Codex keeps its own session in `state.codexSessionId` using `codex exec resume <id>`, but Claude and Codex sessions are not interoperable. Each successful Codex fallback appends a summary to `.claude-bot/codex-handoff.md`, and future Claude calls receive the recent handoff notes as context.
- **Runtime provider switching**: use `/provider` to view the active provider, `/provider claude` or `/provider codex` to store a bot-state override, and `/provider default` to return to the config value. Each provider's session is preserved separately.
- **Ollama fallback**: set `"ollamaFallback": true` and point `"ollamaModel"` at a locally-installed [Ollama](https://ollama.ai) model (default: `"qwen3.5:4b"`). Ollama is now a secondary automatic fallback when Codex is disabled or fails, and `/ollama` still toggles local chat mode manually. It runs Claude Code through the local model via `ollama launch claude … --resume <session>`, but this remains best-effort because local model context windows are much smaller than Claude's.
- **Auto-compact**: the bot tracks how many cached tokens are in the session context. When `cache_read_input_tokens` exceeds `autoCompactThreshold` (default 100 000), it automatically runs `/compact` and notifies you. Tune the threshold in config, or at runtime with `/autocompact <number>` (`/autocompact off` to disable, `/autocompact default` to reset) — the override persists in `state.json` across restarts. You can also run `/compact` manually at any time.

### Custom commands

Define project-specific `/commands` in config that run shell scripts and return their output to the chat. Commands appear in Telegram's `/` autocomplete menu automatically.

```json
"commands": {
  "deploy": { "run": "npm run deploy", "description": "Deploy to production" },
  "logs":   { "run": "tail -n 50 ./app.log", "description": "Recent logs" },
  "status": { "run": "git status && git log --oneline -5", "description": "Git status" }
}
```

- **`run`** — any shell command, executed in `projectDir`
- **`description`** — shown in the Telegram `/` autocomplete menu
- **Arguments**: `/deploy staging` appends `staging` to the command (`npm run deploy staging`)
- Scripts run independently of Claude — they work even when Claude is busy
- Output capped at 4 000 characters; 60-second timeout

### Scheduled tasks (cron)

Add a `schedule` array to the config to run prompts on a timer — daily briefings, periodic
checks, reminders. Each entry runs the prompt and sends the result to `allowedChatId`.

```json
"schedule": [
  { "cron": "0 9 * * 1-5", "label": "Morning brief", "prompt": "Summarize today's open issues and TODOs" },
  { "cron": "*/30 * * * *", "prompt": "Check CI status; only reply if something is red" }
]
```

- **`cron`** — standard 5-field expression `minute hour day-of-month month day-of-week`
  (e.g. `0 9 * * 1-5` = 09:00 on weekdays). Supports `*`, lists (`1,3,5`), ranges (`1-5`),
  and steps (`*/15`). Day-of-week `0` and `7` both mean Sunday. Times use the **host's local
  timezone**. No external dependency — the parser lives in `bot.mjs`.
- **`prompt`** (required) — the message sent to Claude. **`label`** (optional) — a short name
  shown in the reply footer and in `/cron`.
- **Fresh session**: scheduled jobs run in their **own session** so they never pollute your
  interactive conversation context (`state.json` stays yours). They run in their own slot, so
  they don't wait on your rooms (and your rooms don't wait on them) — but they serialize against
  each other, so a job is **skipped** (logged) if another scheduled job is still running when it
  fires.
- **Silent jobs (conditional alerts)**: if Claude's output is **empty or exactly `SKIP`**, that run
  sends **nothing** to Telegram. To get "alert only when it matters, stay quiet otherwise," tell the
  prompt to *output just `SKIP` when the condition isn't met*. This lets even frequent jobs (e.g.
  every 5 minutes) run without spamming the chat.

**Add jobs from the chat — in plain language:**

```
/cron add summarize open issues every weekday at 9am
```

The bot asks Claude to turn that into a cron expression, **echoes back what it understood**
(so you can catch a misread), and saves it to `state.json` — **no restart needed**. Dynamic
jobs get an id; manage them with:

- `/cron` — list everything (config jobs are tagged `[config]`; dynamic ones show `#id`)
- `/cron add <plain-language request>` — e.g. `/cron add every 30 min, ping me if CI is red`
- `/cron rm <id>` — remove a dynamic job (config jobs are edited in the file)

Config-defined jobs still require a restart to change; only chat-added jobs are live.

---

## Running multiple projects

The code is project-agnostic: make **one config file per project** and run several at once.

- Run: `node bot.mjs /absolute/path/to/project.config.json` (no arg → `./mybot.json`, fallback `./config.json`)
- `state.json` and `attachments/` live in the **config file's folder**, so projects don't mix.
- **Note**: Telegram allows only one poller per token → each project needs its **own BotFather
  token**.
- For always-on, copy the launchd template per project (see below).

Example — two projects:

```
~/projects/A/claudebot.config.json   (token A, projectDir=~/projects/A)
~/projects/B/claudebot.config.json   (token B, projectDir=~/projects/B)
node bot.mjs ~/projects/A/claudebot.config.json   # instance A
node bot.mjs ~/projects/B/claudebot.config.json   # instance B
```

## Multiple personas (roles)

You can split the **same project** into role-based bots (e.g. **Developer** + **Planner**).
One codebase, **a separate config file per role**.

- **`persona`**: a role system prompt in the config becomes that bot's identity. The concise-Telegram
  instruction is injected automatically, so `persona` only needs the role itself.
- **Differentiated permissions via `permissionMode`**: since the bots share a folder, keep the
  shell-using bot (`bypassPermissions`) to **just one** to avoid concurrent-edit conflicts. For
  read/plan-only, use `plan`.
- **Session isolation**: the `state` filename is derived from the config name
  (`mybot.json` → `mybot.state.json`, `dev.config.json` → `dev.config.state.json`), so multiple configs
  in one folder don't share context.
- **One token per bot**: each bot needs its own BotFather token (`allowedChatId` can be the same).

Example — Developer + Planner:

```
dev.config.json       (permissionMode: bypassPermissions, persona: "Senior developer...")
planner.config.json   (permissionMode: plan,              persona: "Product/UX planner...")
node bot.mjs dev.config.json
node bot.mjs planner.config.json
```

| Bot | permissionMode | Role |
|---|---|---|
| Developer | `bypassPermissions` | Implement, edit, test, git |
| Planner | `plan` (read/plan only) | Feature proposals, specs, UX direction |

> For always-on, copy `com.claudebot.example.plist` **per bot** and register each with a distinct
> `Label`, config argument, and log paths (see below).

---

## How to run

| Method | When terminal closes | After reboot | On crash | Use for |
|---|---|---|---|---|
| `node bot.mjs` | stops | ✗ | ✗ | testing, finding chatId |
| `nohup node bot.mjs > bot.log 2>&1 &` | survives | ✗ | ✗ | quick background run |
| **launchd (LaunchAgent)** | survives | ✅ auto-start | ✅ auto-restart | **always-on (recommended)** |

> `node bot.mjs &` also backgrounds it, but closing the terminal kills it (SIGHUP). Use `nohup` to
> survive that, and launchd to survive reboots/crashes.

## Always-on with launchd (macOS)

Keeps the bot alive across reboots and crashes. It runs as a **LaunchAgent** in your login session,
so it reuses Claude's keychain/OAuth auth.

### 1. Check the plist (paths / node version)

`com.claudebot.example.plist` assumes certain paths — fix them first if yours differ:

```sh
which node     # must match the node path in ProgramArguments
which claude   # its directory must be on PATH (EnvironmentVariables)
```

Items to verify in the plist:

- `ProgramArguments` [0] — absolute path to `node`
- `ProgramArguments` [1] — absolute path to `bot.mjs`
- `WorkingDirectory` — the project folder
- `EnvironmentVariables > PATH` — includes your node/claude directories
- `StandardOutPath` / `StandardErrorPath` — log file paths

### 2. Register & start

```sh
cp com.claudebot.example.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.example.plist
```

> Modern macOS prefers `bootstrap`/`bootout`. The old `load`/`unload` still works but may print a
> deprecation warning. If `bootstrap` fails, fall back to
> `launchctl load ~/Library/LaunchAgents/com.claudebot.example.plist`.

### 3. Manage

```sh
launchctl list | grep claudebot      # registered/running? (a PID means it's up)
tail -f bot.log                      # run log
tail -f bot.error.log                # error log

# stop
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.example.plist

# restart after editing code (bootout → bootstrap)
launchctl bootout   gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.example.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.example.plist
```

### Troubleshooting

- **`launchctl list` shows an error code with no PID** → check `bot.error.log`. Usually a node/claude
  path issue (`command not found`) or a missing `config.json`.
- **Bot doesn't respond** → Claude auth may have expired. Run `node bot.mjs` directly and confirm
  `claude` is logged in.
- **Mac is asleep → polling stops** → disable sleep in System Settings > Battery/Power.
- **Repeated "polling error" (ETIMEDOUT)** → some networks block IPv6, so Node's fetch times out
  against api.telegram.org (which has an IPv6 address). `bot.mjs` already works around this by
  preferring IPv4 (`dns.setDefaultResultOrder('ipv4first')` + disabling auto-select). If it still
  fails, check the network/firewall with `curl https://api.telegram.org`.

---

## Requirements

- Node.js 18+ (for built-in `fetch`)
- A Telegram bot token from `@BotFather`
- At least one provider: authenticated Claude CLI or authenticated Codex CLI
- Optional: Codex CLI for Codex fallback; Ollama and a downloaded model for Ollama mode/fallback

## Development

```sh
npm test
```

The smoke test runs `node --check` on the CLI files and verifies both binaries can print their
version. CI runs the same checks on Node 18, 20, and 22.

See [CHANGELOG.md](./CHANGELOG.md) for recent changes.

## License

MIT © Jongtaek Choi
