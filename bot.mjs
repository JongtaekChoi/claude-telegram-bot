#!/usr/bin/env node
// Cube Brain Trainer 전용 Claude Code 텔레그램 봇
// 의존성 없음 — Node 18+ 내장 fetch + child_process 만 사용.
//
// 흐름: 텔레그램 메시지 → claude -p (헤드리스) → 결과를 다시 텔레그램으로.
// 설정은 같은 폴더의 config.json 에서 읽음 (config.example.json 참고).

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(HERE, 'config.json')
const STATE_PATH = join(HERE, 'state.json')

if (!existsSync(CONFIG_PATH)) {
  console.error(`설정 파일이 없습니다: ${CONFIG_PATH}\nconfig.example.json 을 config.json 으로 복사해서 채우세요.`)
  process.exit(1)
}

const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const TG = `https://api.telegram.org/bot${cfg.token}`

// ── 상태 (세션 이어가기용) ────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch { return {} }
}
function saveState(s) {
  try { writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)) } catch (e) { console.error('상태 저장 실패', e) }
}
let state = loadState() // { sessionId?: string }

// ── 텔레그램 헬퍼 ─────────────────────────────────────────────────────────
async function tg(method, body) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

function* chunks(text, size = 3800) {
  let t = String(text ?? '')
  if (t.length === 0) { yield '(빈 응답)'; return }
  while (t.length > 0) {
    if (t.length <= size) { yield t; return }
    // 가능하면 줄바꿈 경계에서 자르기
    let cut = t.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = size
    yield t.slice(0, cut)
    t = t.slice(cut)
  }
}

async function send(chatId, text) {
  for (const c of chunks(text)) {
    await tg('sendMessage', { chat_id: chatId, text: c, disable_web_page_preview: true })
  }
}

// ── Claude 실행 ───────────────────────────────────────────────────────────
function runClaude(prompt, sessionId) {
  return new Promise((resolve) => {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--permission-mode', cfg.permissionMode || 'acceptEdits',
    ]
    if (cfg.model) args.push('--model', cfg.model)
    if (sessionId) args.push('--resume', sessionId)

    const child = spawn(cfg.claudeBin || 'claude', args, {
      cwd: cfg.projectDir,
      env: { ...process.env, ...(cfg.env || {}) },
    })

    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => resolve({ ok: false, text: `claude 실행 실패: ${e.message}` }))
    child.on('close', (code) => {
      try {
        const j = JSON.parse(out)
        resolve({ ok: !j.is_error, text: j.result ?? '(빈 응답)', sessionId: j.session_id, cost: j.total_cost_usd })
      } catch {
        resolve({ ok: false, text: `실행 오류 (exit ${code}):\n${(err || out || '출력 없음').slice(0, 3500)}` })
      }
    })
  })
}

// ── 메시지 처리 ───────────────────────────────────────────────────────────
let busy = false

async function handle(msg) {
  const chatId = msg.chat?.id
  const text = (msg.text || '').trim()
  if (!chatId || !text) return

  // 화이트리스트
  if (!cfg.allowedChatId) {
    await send(chatId, `이 채팅 ID를 config.json 의 allowedChatId 에 넣으세요:\n${chatId}`)
    return
  }
  if (String(chatId) !== String(cfg.allowedChatId)) {
    console.warn(`허가되지 않은 chatId ${chatId} 무시`)
    return
  }

  // 명령어
  if (text === '/start' || text === '/help') {
    await send(chatId,
      'Cube Brain Trainer 전용 Claude 봇\n\n' +
      '• 그냥 메시지를 보내면 Claude가 프로젝트에서 작업합니다.\n' +
      '• /new — 대화 맥락 초기화 (새 세션)\n' +
      '• /id — 이 채팅 ID 확인\n' +
      `\n작업 폴더: ${cfg.projectDir}\n권한 모드: ${cfg.permissionMode}`)
    return
  }
  if (text === '/id') { await send(chatId, `chatId: ${chatId}`); return }
  if (text === '/new') {
    state.sessionId = undefined
    saveState(state)
    await send(chatId, '🆕 새 대화를 시작합니다 (이전 맥락 초기화).')
    return
  }

  if (busy) { await send(chatId, '⏳ 이전 작업이 아직 진행 중입니다. 끝나면 다시 보내주세요.'); return }
  busy = true
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' })
  const started = Date.now()
  // 긴 작업 동안 타이핑 표시 유지
  const typing = setInterval(() => tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}), 5000)

  try {
    const res = await runClaude(text, state.sessionId)
    if (res.sessionId) { state.sessionId = res.sessionId; saveState(state) }
    const secs = Math.round((Date.now() - started) / 1000)
    const footer = res.ok ? `\n\n— ${secs}s${res.cost ? ` · $${res.cost.toFixed(4)}` : ''}` : ''
    await send(chatId, (res.ok ? res.text : `⚠️ ${res.text}`) + footer)
  } catch (e) {
    await send(chatId, `봇 오류: ${e.message}`)
  } finally {
    clearInterval(typing)
    busy = false
  }
}

// ── 롱폴링 루프 ───────────────────────────────────────────────────────────
async function main() {
  console.log('봇 시작. 텔레그램 폴링 중...')
  // 시작 시 밀린 메시지 건너뛰기
  let offset = 0
  try {
    const init = await tg('getUpdates', { timeout: 0, offset: -1 })
    if (init.ok && init.result.length) offset = init.result[init.result.length - 1].update_id + 1
  } catch {}

  while (true) {
    try {
      const res = await tg('getUpdates', { offset, timeout: 30 })
      if (!res.ok) { await new Promise(r => setTimeout(r, 2000)); continue }
      for (const upd of res.result) {
        offset = upd.update_id + 1
        if (upd.message) await handle(upd.message)
      }
    } catch (e) {
      console.error('폴링 오류:', e.message)
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

main()
