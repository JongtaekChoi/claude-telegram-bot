// Standalone Claude session manager — zero-dependency (Node 18+ built-ins only).
// Maintains conversational context across calls by persisting --resume session IDs.
//
// Usage:
//   import { createSession } from 'claude-telegram-bot/session.mjs'
//
//   const session = createSession({ projectDir: '/my/project' })
//   const r1 = await session.run('리팩토링 계획 세워줘')
//   const r2 = await session.run('그걸 실제로 실행해줘')  // r1 컨텍스트 유지
//   session.reset()                                       // 세션 초기화
//
// statePath defaults to <projectDir>/.claude-bot/session.json.
// To share state with a running bot, pass the bot's state path explicitly:
//   statePath: '/path/to/bot-config-dir/.claude-bot/state.json'

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

function loadState(statePath) {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return {}
  }
}

function saveState(statePath, state) {
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(state, null, 2))
  } catch (e) {
    console.error('Failed to save session state:', e.message)
  }
}

function _runClaude(prompt, sessionId, opts) {
  return new Promise((resolve) => {
    const {
      projectDir = process.cwd(),
      permissionMode = 'acceptEdits',
      model,
      claudeBin = 'claude',
      appendSystemPrompt,
      env = {},
    } = opts

    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--permission-mode', permissionMode,
    ]
    if (model) args.push('--model', model)
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt)
    if (sessionId) args.push('--resume', sessionId)

    const child = spawn(claudeBin, args, {
      cwd: projectDir,
      env: { ...process.env, ...env },
    })

    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => resolve({ ok: false, text: `Failed to start claude: ${e.message}` }))
    child.on('close', (code) => {
      try {
        const j = JSON.parse(out)
        resolve({
          ok: !j.is_error,
          text: j.result ?? '(empty response)',
          sessionId: j.session_id,
          cost: j.total_cost_usd,
        })
      } catch {
        resolve({
          ok: false,
          text: `Execution error (exit ${code}):\n${(err || out || 'no output').slice(0, 3500)}`,
        })
      }
    })
  })
}

/**
 * Create a stateful Claude session.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir]        Working directory for claude (default: process.cwd())
 * @param {string} [opts.statePath]         Where to persist the session ID (default: <projectDir>/.claude-bot/session.json; bot uses <configDir>/.claude-bot/state.json)
 * @param {string} [opts.permissionMode]    Claude permission mode (default: 'acceptEdits')
 * @param {string} [opts.model]             Model override (e.g. 'sonnet', 'opus')
 * @param {string} [opts.claudeBin]         Path to the claude CLI (default: 'claude')
 * @param {string} [opts.appendSystemPrompt] Extra system prompt to append
 * @param {object} [opts.env]               Extra environment variables
 * @returns {{ run(prompt: string): Promise<{ok, text, sessionId, cost}>, reset(): void, getSessionId(): string|undefined }}
 */
export function createSession(opts = {}) {
  const projectDir = opts.projectDir ?? process.cwd()
  const statePath = opts.statePath ?? join(projectDir, '.claude-bot', 'session.json')
  const claudeOpts = {
    projectDir,
    permissionMode: opts.permissionMode ?? 'acceptEdits',
    model: opts.model,
    claudeBin: opts.claudeBin ?? 'claude',
    appendSystemPrompt: opts.appendSystemPrompt,
    env: opts.env ?? {},
  }

  let state = loadState(statePath)

  return {
    async run(prompt) {
      const res = await _runClaude(prompt, state.sessionId, claudeOpts)
      if (res.sessionId) {
        state.sessionId = res.sessionId
        saveState(statePath, state)
      }
      return res
    },
    reset() {
      state.sessionId = undefined
      saveState(statePath, state)
    },
    getSessionId() {
      return state.sessionId
    },
  }
}
