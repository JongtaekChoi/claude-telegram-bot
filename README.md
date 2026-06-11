# Claude Telegram Bot

[한국어](./README.ko.md) · **English**

[![npm version](https://img.shields.io/npm/v/claude-telegram-bot.svg)](https://www.npmjs.com/package/claude-telegram-bot)
[![npm downloads](https://img.shields.io/npm/dm/claude-telegram-bot.svg)](https://www.npmjs.com/package/claude-telegram-bot)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**A zero-dependency, single-file, daemonized Claude Code bot — no Bun, no Python, no open session.**

A tiny bridge that takes your Telegram messages, runs `claude -p` (Claude Code headless mode)
in a project folder, and sends the result back to the chat. One `.mjs` file on Node 18+ built-ins —
nothing to `npm install`, nothing to audit but ~400 readable lines.

```
[you] → Telegram → bot.mjs → claude -p (config.projectDir) → result → Telegram
```

Drive Claude Code from your phone: run tests, edit files, commit, push — all from a chat.
It runs as a **background daemon** (launchd), so there's no interactive session to keep open.

> ### ⚠️ This is a remote code-execution tool by design. Read the [Security](#security) section before running it.
> A message you send from Telegram is executed as a command on the machine running the bot.
> With `permissionMode: bypassPermissions`, a one-line message can run **anything** as your user.

**Highlights**

- **Zero dependencies** — just Node 18+. No npm install, no supply chain.
- **Multi-project** — one codebase drives many projects via per-project config files.
- **Multi-persona** — split the *same* project into role-based bots (e.g. Developer + Planner)
  with per-bot system prompts and **differentiated permission levels**.
- **Session continuity** — conversations resume across restarts (`--resume`); `/new` to reset.
- **Attachments** — send photos/docs/voice/video; they're saved locally and handed to Claude.
- **Always-on** — ships with a launchd template for macOS (auto-start, auto-restart).

## How it compares

This space is crowded, and Anthropic now ships an official solution. Here's an honest map so you
can pick the right tool:

| | This bot | [Official Claude Code Channels](https://code.claude.com/docs/en/channels) | [claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) |
|---|---|---|---|
| Runtime | **Node built-ins only** | Bun + MCP plugin | Python 3.11+ + libs |
| Execution model | headless `claude -p` per message | events pushed into an **open** `claude --channels` session | Claude SDK / CLI |
| Stays running as | **background daemon** (no session open) | a live interactive session you keep running | service / daemon |
| Multi-persona, permission-scoped bots on one repo | **yes** (dev=`bypass`, planner=`plan`) | no | no |
| Per-action permission approval (inline buttons) | no (set `permissionMode`) | **yes** | partial |
| Feature breadth (webhooks, cron, voice, export) | minimal | medium | **large** |
| Lines of code to read/fork | **~400, one file** | larger | large |

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
- **There is no sandbox.** The bot runs `claude` as *your* user, with your filesystem, your SSH/git
  credentials, and your Claude OAuth/keychain session. It can do anything you can.

### Choose the least permission you can live with

`permissionMode` is the main safety dial:

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

### Reporting a vulnerability

Found a security issue? Please open a GitHub issue (or contact the maintainer privately for
sensitive reports) rather than posting exploit details publicly.

---

## Install & run

This is a standalone CLI/daemon, **not a library** — you don't `import` it. Install it globally (or
run via `npx`), point a config file at any project, and run it. `projectDir` in the config decides
which folder Claude works in, independent of where the bot is installed.

Prerequisites: **Node 18+** and the **`claude` CLI installed and authenticated** on the host.

**Option A — npx (no install)**

```sh
npx claude-telegram-bot init        # writes ./config.json
# edit config.json (token, projectDir, …)
npx claude-telegram-bot             # runs ./config.json
```

**Option B — global install (recommended for an always-on daemon)**

```sh
npm i -g claude-telegram-bot

claude-telegram-bot init ~/botconfigs/myproj    # writes ~/botconfigs/myproj/config.json
# edit that config.json (token, projectDir, …)
claude-telegram-bot ~/botconfigs/myproj/config.json
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
message in Telegram; it replies with this chat's `chatId`. Put that number into `config.json`
`allowedChatId` and restart. Now only you can use it. (See [Security](#security) — this is your only
auth layer.)

**3) Use it** — just send messages:

- `run the solver tests and commit + push if they pass`
- `add an edge case to solve-2nd-floor-edges.ts`

Commands: `/new` (reset context / new session) · `/cron` (list / add / remove scheduled tasks) · `/restart` (syntax-check & restart the bot) · `/status` (bot status & version) · `/model` (view / switch the model) · `/id` (show chat ID) · `/help`.

> **`/restart`** runs `node --check` on `bot.mjs` first and **aborts the restart if it has a syntax
> error** (so a bad edit can't crash-loop the bot), then exits — relying on a process supervisor
> to relaunch it. Works out of the box with the [launchd setup](#always-on-with-launchd-macos)
> (`KeepAlive`); under a bare `node bot.mjs` with no supervisor it just stops. Your session resumes
> after the restart (the id lives in `state.json`).

**4) Keep it always on (optional)** — see [Always-on with launchd](#always-on-with-launchd-macos).

> **From source** (for hacking on the bot): clone the repo, `cp config.example.json config.json`,
> then `node bot.mjs [config.json]`. Same behavior as the CLI.

---

## Configuration

```sh
cp config.example.json config.json
```

Edit `config.json`:

| Key | Description |
|---|---|
| `token` | Bot token from BotFather |
| `allowedChatId` | **Leave empty at first** → the bot tells you (step 3). Required before it runs anything. |
| `projectDir` | Absolute path to the working folder Claude runs in |
| `claudeBin` | Output of `which claude` (absolute path recommended) |
| `permissionMode` | `plan` / `acceptEdits` / `bypassPermissions` — see [Security](#security) |
| `model` | Empty = default. Or `opus` / `sonnet`, etc. Override at runtime with `/model` (persists in state). |
| `lang` | (optional) UI language. Empty = auto-detect per user (English default, Korean for Korean Telegram clients). Force with `"en"` / `"ko"`. |
| `name` | (optional) Bot name shown in `/help` — handy for telling multiple bots apart |
| `persona` | (optional) Role system prompt — defines a persona (developer/planner/…). See below |
| `appendSystemPrompt` | (optional) Override the default "be concise for Telegram" instruction |
| `env` | (optional) Extra environment variables passed to the `claude` process |
| `schedule` | (optional) Cron jobs that run a prompt on a timer — see [Scheduled tasks](#scheduled-tasks-cron) |

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
  absolute path is handed to Claude (caption included as the message). Images can be opened with Read.
- **Sessions**: conversations resume automatically (`--resume`); the last session id is saved in
  `state.json`, so context survives restarts. Use `/new` to start fresh.

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
  interactive conversation context (`state.json` stays yours). They share the single-task lock,
  so a job is **skipped** (logged) if a task is already running when it fires.
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

- Run: `node bot.mjs /absolute/path/to/project.config.json` (no arg → `./config.json`)
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
  (`config.json` → `state.json`, `dev.config.json` → `dev.config.state.json`), so multiple configs
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
- The `claude` CLI installed and authenticated on the host
- A Telegram bot token from `@BotFather`

## License

MIT © Jongtaek Choi
