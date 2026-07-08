# Claude Telegram Bot

[한국어](./README.ko.md) · **English**

[![npm version](https://img.shields.io/npm/v/claude-telegram-bot.svg)](https://www.npmjs.com/package/claude-telegram-bot)
[![npm downloads](https://img.shields.io/npm/dm/claude-telegram-bot.svg)](https://www.npmjs.com/package/claude-telegram-bot)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Use Claude Code from Telegram — run tests, edit files, review plans, and keep working from your phone.

**A zero-dependency, daemonized Claude Code bot for people who already use the `claude` CLI.**
It runs headless `claude -p` in your project folder and sends the result back to Telegram. No web dashboard, no database, no Python/Bun service to maintain.

```
[you] → Telegram → bot.mjs → claude -p (config.projectDir) → result → Telegram
```

> ### ⚠️ Remote code execution by design
> A Telegram message can make the host machine run code. Start with `permissionMode: acceptEdits`, always set `allowedChatId`, and read [Security](#security) before leaving the bot always-on.

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

For a no-install trial, use `npx claude-telegram-bot init` and `npx claude-telegram-bot` instead.

## Why this exists

Sometimes you are away from your desk but still want to ask Claude Code to inspect a repo, run tests, make a small edit, or prepare a commit. Remote desktop and SSH are heavy for that; a Telegram chat is enough.

This project is intentionally small: a CLI/daemon that reuses the `claude` CLI already authenticated on your machine. It is best for a Mac mini, home server, dev box, or personal VPS that you already trust.

## Highlights

- **Zero dependencies** — Node 18+ built-ins only.
- **Daemon-friendly** — ships with a macOS `launchd` template for always-on use.
- **Headless Claude Code** — runs `claude -p` per message in `projectDir`.
- **Session continuity** — resumes conversations across restarts; `/new` starts fresh.
- **Plan approval flow** — `/plan <request>` runs read-only first, then you approve or cancel.
- **Multi-project / multi-persona** — use one config per project or role.
- **Attachments** — photos, docs, voice, and video are saved locally and passed to Claude.
- **Queueing and recovery** — busy messages are queued; rate-limit resets can be reserved and retried.
- **Local fallback** — optional Ollama mode/fallback for lightweight or rate-limited moments.

## How it compares

| | This bot | [Official Claude Code Channels](https://code.claude.com/docs/en/channels) | [claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) |
|---|---|---|---|
| Runtime | **Node built-ins only** | Bun + MCP plugin | Python 3.11+ + libs |
| Execution model | headless `claude -p` per message | events pushed into an **open** `claude --channels` session | Claude SDK / CLI |
| Stays running as | **background daemon** | live interactive session | service / daemon |
| Multi-persona, permission-scoped bots | **yes** | no | no |
| Per-action permission approval | `/plan` review flow; config-level permission | **yes** | partial |
| Feature breadth | focused | medium | large |

Use the official Channels if you want per-action approvals and do not mind keeping a live session open. Use `claude-code-telegram` if you want a larger feature set. Use this bot if you want a minimal, auditable, zero-dependency daemon that is easy to read and fork.

## Install & run

### Option A — global install, recommended for always-on use

```sh
npm i -g claude-telegram-bot
claude-telegram-bot init ~/botconfigs/myproj
# edit token, allowedChatId, projectDir, claudeBin, permissionMode
claude-telegram-bot ~/botconfigs/myproj/mybot.json
```

### Option B — npx, no install

```sh
npx claude-telegram-bot init
# edit ./mybot.json
npx claude-telegram-bot
```

Run several projects/personas by making one config file each and passing its path. State and attachments live in `.claude-bot/` next to the config, so projects do not mix.

> **Keep your config out of git.** It contains your Telegram bot token. If you store a config inside another repo, add the config, `.claude-bot/`, `state*.json`, and `attachments/` to that repo's `.gitignore`.

## Common commands

- `/new` — reset conversation context and start a new session.
- `/compact` — compress context while keeping the session.
- `/plan <request>` — ask Claude to plan read-only, then approve/cancel with buttons.
- `/stop` — stop the running Claude process; `/stop --reset` also rolls back the session.
- `/cron` — list/add/remove scheduled prompt jobs.
- `/reserve` — show or cancel the retry queue after usage-limit resets.
- `/restart` — syntax-check `bot.mjs`, then restart under your process supervisor.
- `/status` — show bot status, version, project, session, and permission mode.
- `/model` — view or switch model.
- `/autocompact` — view or tune the auto-compaction threshold.
- `/ollama` — toggle local Ollama chat mode.
- `/id` — show the current Telegram chat ID.
- `/help` — show the command list.

## Configuration

```sh
cp config.example.json mybot.json
```

| Key | Description |
|---|---|
| `token` | Bot token from `@BotFather` |
| `allowedChatId` | Leave empty on first run; the bot replies with the chat ID. Required before commands run. |
| `projectDir` | Absolute path to the project Claude should work in |
| `claudeBin` | Absolute path to `claude` (`which claude`) |
| `permissionMode` | `plan` / `acceptEdits` / `bypassPermissions` |
| `model` | Empty = Claude default; or `haiku`, `sonnet`, `opus`, `fable`, or a full model id |
| `lang` | Empty = auto; or force `en` / `ko` |
| `name` | Optional bot name shown in `/help` |
| `persona` | Optional role system prompt for persona bots |
| `appendSystemPrompt` | Optional override for the default concise Telegram instruction |
| `env` | Extra environment variables passed to Claude |
| `schedule` | Cron jobs that run prompts on a timer |
| `commands` | Custom `/commands` that run shell scripts |
| `ollamaFallback` | Enable Ollama fallback on Claude rate-limit/credit errors |
| `ollamaModel` | Ollama model name, default `phi3:mini` |
| `autoCompactThreshold` | Cached-token threshold for automatic `/compact`; `0` disables |

## Permission modes

| Mode | What it allows | Use when |
|---|---|---|
| `plan` | Read and plan only, no edits | Q&A, code review, planning/persona bots |
| `acceptEdits` | Auto-approve file edits; shell and other actions stay gated | **Recommended default** |
| `bypassPermissions` | Auto-runs everything, including arbitrary shell | You accept that one chat message can execute code as your user |

Prefer `acceptEdits` unless you specifically need autonomous shell/git. If you run multiple persona bots on the same project, keep at most one bot on `bypassPermissions`.

## Custom commands

Define project-specific `/commands` in config that run shell scripts and return output to Telegram:

```json
"commands": {
  "deploy": { "run": "npm run deploy", "description": "Deploy to production" },
  "logs":   { "run": "tail -n 50 ./app.log", "description": "Recent logs" },
  "status": { "run": "git status && git log --oneline -5", "description": "Git status" }
}
```

Commands run in `projectDir`, work independently of Claude, accept trailing arguments, time out after 60 seconds, and cap output at 4,000 characters.

## Scheduled tasks

Add a `schedule` array to run prompts on a timer — daily briefings, checks, reminders, or conditional alerts.

```json
"schedule": [
  { "cron": "0 9 * * 1-5", "label": "Morning brief", "prompt": "Summarize today's open issues and TODOs" },
  { "cron": "*/30 * * * *", "prompt": "Check CI status; reply only if something is red, otherwise output SKIP" }
]
```

Cron uses standard 5-field syntax: `minute hour day-of-month month day-of-week`, in the host's local timezone. If Claude outputs nothing or exactly `SKIP`, no Telegram message is sent.

You can also add dynamic jobs from chat:

```text
/cron add summarize open issues every weekday at 9am
```

## Multiple projects and personas

Use one config per project or role:

```sh
claude-telegram-bot ~/projects/A/claudebot.config.json
claude-telegram-bot ~/projects/B/claudebot.config.json
```

Telegram allows one poller per token, so each running bot needs its own BotFather token. State files are derived from config names, so contexts stay isolated.

For the same project, split roles with `persona` and `permissionMode`:

| Bot | permissionMode | Role |
|---|---|---|
| Developer | `acceptEdits` or `bypassPermissions` | Implement, test, commit |
| Planner | `plan` | Specs, UX, issue triage |

## Always-on with launchd on macOS

The included `com.claudebot.example.plist` keeps the bot alive across reboots and crashes as a LaunchAgent, reusing your normal Claude keychain/OAuth session.

Check paths first:

```sh
which node
which claude
```

Then copy, edit, and register:

```sh
cp com.claudebot.example.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.example.plist

launchctl list | grep claudebot
tail -f bot.log
tail -f bot.error.log

launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.example.plist
```

Use a distinct plist `Label`, config path, and log path for each bot.

## Troubleshooting

- **`launchctl list` shows an error code with no PID** — check `bot.error.log`; usually a node/claude path or config issue.
- **Bot does not respond** — run the bot directly and confirm the `claude` CLI is still authenticated.
- **Mac sleeps** — polling stops while the host sleeps; disable sleep for always-on use.
- **Repeated `ETIMEDOUT` polling errors** — some networks break IPv6 routes. The bot prefers IPv4 already, but check firewall/network with `curl https://api.telegram.org`.
- **Nothing runs on first start** — set `allowedChatId`; before that the bot only replies with the chat ID.

## Security

Treat this tool like an SSH key into your machine that lives in Telegram.

- Anyone with access to the allowed Telegram chat can ask the bot to act.
- Anyone with the bot token can read/impersonate bot messages; revoke leaked tokens via `@BotFather`.
- Prompt-injected files, webpages, or issues can steer Claude. Do not feed untrusted content to a high-permission bot.
- There is no sandbox. Claude runs as your user, with your filesystem, git/SSH credentials, and Claude auth.

Practical hardening:

- Always set `allowedChatId`.
- Prefer `acceptEdits` over `bypassPermissions`.
- Point `projectDir` at one project, not your home directory.
- Consider a dedicated user account or VM for always-on use.

## Development

```sh
npm test
```

The smoke test runs `node --check` on the CLI files and verifies both binaries can print their version. CI runs the same checks on Node 18, 20, and 22.

See [CHANGELOG.md](./CHANGELOG.md) for recent changes.

## License

MIT © Jongtaek Choi
