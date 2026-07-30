#!/usr/bin/env node
// Claude Code 텔레그램 봇 (범용 — 여러 프로젝트 재사용 가능)
// 의존성 없음 — Node 18+ 내장 fetch + child_process 만 사용.
//
// 흐름: 텔레그램 메시지 → claude -p (헤드리스, config.projectDir 에서 실행) → 결과를 텔레그램으로.
// 설정 파일 경로는 인자/BOT_CONFIG 환경변수로 지정 (없으면 같은 폴더의 config.json).
//   node bot.mjs /path/to/projectA.config.json
// 프로젝트마다 config 파일을 따로 두면 한 코드로 여러 프로젝트를 동시에 운영 가능
// (단, 텔레그램은 토큰당 폴링 1개라 프로젝트마다 BotFather 토큰이 별도여야 함).
// 같은 프로젝트를 역할별 봇(개발자/기획자 등)으로 나누려면 config 마다 `persona`(역할
// 시스템 프롬프트)와 `permissionMode` 를 다르게 주면 됨. state 는 config 이름에서 파생됨.
//
// 사용자 대상 문구는 영어 기본 + 한국어(STR 테이블). 언어는 텔레그램 from.language_code 로
// 자동 판별하고, cfg.lang 을 주면 그 언어로 고정함. 콘솔/CLI 출력은 영어 단일.

import { basename, dirname, join, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import dns from "node:dns";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { spawn } from "node:child_process";

// 일부 네트워크에서 IPv6 경로가 막혀 있으면 Node의 fetch(undici)가 IPv6를
// 물고 타임아웃남(api.telegram.org가 IPv6를 가짐). IPv4 우선 + 자동선택 끄기로 회피.
dns.setDefaultResultOrder("ipv4first");
if (net.setDefaultAutoSelectFamily) net.setDefaultAutoSelectFamily(false);

const SELF = fileURLToPath(import.meta.url); // /restart 자기 문법검사용
const HERE = dirname(SELF);
// package.json 버전을 1회만 읽어 캐시 (--version, /status 에서 사용).
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version;
  } catch {
    return "?";
  }
})();

// ── CLI (help / version / init) ───────────────────────────────────────────
{
  const a = process.argv[2];
  if (a === "-h" || a === "--help") {
    console.log(`claude-telegram-bot — Telegram → claude -p bridge

Usage:
  claude-telegram-bot [config.json path]   Run the bot (default ./config.json, or BOT_CONFIG env)
  claude-telegram-bot init [dir]           Create a config.json template (default: current dir)
  claude-telegram-bot --help | --version

state.json and attachments/ are stored next to the config file.
Requires: the claude CLI installed and authenticated on the host.`);
    process.exit(0);
  }
  if (a === "-v" || a === "--version") {
    console.log(VERSION);
    process.exit(0);
  }
  if (a === "init") {
    const arg = process.argv[3];
    const target = arg?.endsWith(".json") ? resolve(arg) : join(arg || process.cwd(), "mybot.json");
    if (existsSync(target)) {
      console.error(`Already exists: ${target}`);
      process.exit(1);
    }
    writeFileSync(target, readFileSync(join(HERE, "config.example.json"), "utf8"));
    console.log(`Created: ${target}\nFill in token / allowedChatId / projectDir, then run it.`);
    process.exit(0);
  }
}

// Config path via arg or BOT_CONFIG env so one shared codebase can drive many
// projects; state + attachments live next to that config, keeping projects
// isolated. Defaults to mybot.json, falls back to config.json for existing setups.
const _defaultCfg = existsSync(join(HERE, "mybot.json")) ? join(HERE, "mybot.json") : join(HERE, "config.json");
const CONFIG_PATH = process.argv[2] || process.env.BOT_CONFIG || _defaultCfg;
const DATA_DIR = dirname(CONFIG_PATH);
// 데이터(state·attachments)는 config 폴더 아래 숨김 폴더 .claude-bot/ 에 모은다.
// state 파일명은 config 이름에서 파생 → 여러 페르소나 config 가 한 .claude-bot/ 를 공유해도 안 섞임
// (config.json → state.json, 그 외 foo.json → foo.state.json).
const stateBase = basename(CONFIG_PATH, ".json");
const stateFile = stateBase === "config" ? "state.json" : `${stateBase}.state.json`;
const BOT_DIR = join(DATA_DIR, ".claude-bot");
const STATE_PATH = join(BOT_DIR, stateFile);
const ATTACH_DIR = join(BOT_DIR, "attachments");
const MEMORY_PATH = join(BOT_DIR, "memory.md"); // /new 로 초기화해도 유지되는 퍼시스턴트 메모리
const CODEX_HANDOFF_PATH = join(BOT_DIR, "codex-handoff.md"); // Codex fallback 작업을 Claude에 넘길 요약
const LEGACY_STATE_PATH = join(DATA_DIR, stateFile); // 구버전(루트 직하) 호환
const LEGACY_ATTACH_DIR = join(DATA_DIR, "attachments");

// 구버전에서 올라온 경우, 루트 직하 데이터를 .claude-bot/ 로 1회 이동(무손실, 실패 시 기존 경로 폴백).
function migrateData() {
  try {
    mkdirSync(BOT_DIR, { recursive: true });
    if (!existsSync(STATE_PATH) && existsSync(LEGACY_STATE_PATH)) {
      renameSync(LEGACY_STATE_PATH, STATE_PATH);
      console.log(`Migrated state → ${STATE_PATH}`);
    }
    if (!existsSync(ATTACH_DIR) && existsSync(LEGACY_ATTACH_DIR)) {
      renameSync(LEGACY_ATTACH_DIR, ATTACH_DIR);
      console.log(`Migrated attachments → ${ATTACH_DIR}`);
    }
    if (IMAGE_SEND) mkdirSync(OUTBOX_DIR, { recursive: true }); // 에이전트가 보낼 이미지를 놓는 폴더
  } catch (e) {
    console.error("Data migration skipped:", e.message);
  }
}

if (!existsSync(CONFIG_PATH)) {
  console.error(
    `Config file not found: ${CONFIG_PATH}\nCopy config.example.json to config.json and fill it in.`,
  );
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const DEFAULT_PROVIDER = cfg.provider || "claude";
if (!["claude", "codex"].includes(DEFAULT_PROVIDER)) {
  console.error(`Invalid provider: ${DEFAULT_PROVIDER} (expected claude or codex)`);
  process.exit(1);
}
console.log({ ...cfg, token: cfg.token ? "<redacted>" : "(none)" });
const TG = `https://api.telegram.org/bot${cfg.token}`;
// 이미지 전송(아웃박스): 에이전트가 답변 끝에 [[ctb-image: 파일명 | 캡션]] 마커를 붙이면
// bot.mjs 가 마커를 떼고 그 파일을 사진으로 전송한다. 파일은 아래 전용 폴더에서만 읽으며(basename만
// 취해 경로탈출 불가), projectDir 안에 둬서 Claude·Codex(workspace-write 샌드박스) 둘 다 쓸 수 있다.
const IMAGE_SEND = cfg.sendImages !== false;
const OUTBOX_DIR = join(cfg.projectDir || DATA_DIR, ".ctb-outbox");
const OUTBOX_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const OUTBOX_MAX_BYTES = 10 * 1024 * 1024; // 텔레그램 sendPhoto 상한(대략)
// allowedChatId 는 문자열 또는 배열 모두 허용 (하위 호환)
const allowedIds = []
  .concat(cfg.allowedChatId)
  .filter(Boolean)
  .map(String);

// ── i18n (영어 기본 + 한국어) ─────────────────────────────────────────────
// cfg.lang 를 "en"/"ko" 로 주면 그 언어로 고정. 비우면 메시지의 from.language_code 로
// 사용자별 자동 판별(ko 면 한국어, 그 외 영어). 예약/시작 알림 등 맥락 없는 메시지는 BOT_LANG.
const FORCE_LANG = cfg.lang ? (String(cfg.lang).startsWith("ko") ? "ko" : "en") : null;
const BOT_LANG = FORCE_LANG || "en";
const langOf = (msg) =>
  FORCE_LANG || ((msg?.from?.language_code || "").startsWith("ko") ? "ko" : "en");

const STR = {
  en: {
    help: () =>
      `${cfg.name || "Claude Code Telegram bot"}\n\n` +
      "• Just send a message and Claude works in the project.\n" +
      "• Start a message with // and the bot ignores it — leave yourself a note in the chat\n" +
      "• /new — reset conversation context (new session)\n" +
      "• /compact — compress context to free up space (keeps the session)\n" +
      "• /plan <request> — plan only (no edits), then approve/cancel to run for real\n" +
      "• Codex fallback can run automatically when Claude hits a limit (if enabled)\n" +
      "• /ollama — toggle Ollama chat mode (bypass Claude, use local LLM)\n" +
      "• /stop — stop the current task · /stop --reset to also roll back the session\n" +
      "• /local — local `ctb` session status · end it from here when it's blocking the bot\n" +
      "• /cron — list tasks · /cron add <natural language> to add · /cron rm <id> to remove\n" +
      "• /remember <text> — save to persistent memory (survives /new)\n" +
      "• /memory — view memory · /memory clear to wipe\n" +
      "• /reserve — show retry queue status at usage-limit reset · /reserve rm to cancel\n" +
      "• /restart — restart the bot (after a syntax check)\n" +
      "• /status — bot status & version\n" +
      "• /provider — view / switch the default provider\n" +
      "• /model — view / switch the model\n" +
      "• /autocompact — view / set the auto-compact token threshold\n" +
      "• /id — show this chat ID\n" +
      `\nWorking dir: ${cfg.projectDir}\nPermission mode: ${cfg.permissionMode}`,
    newSession: "🆕 Started a new conversation (previous context cleared).",
    compacting: "🗜️ Compacting… this can take a minute or two.",
    compactOk: "🗜️ Context compacted. The conversation continues with a summary.",
    compactFail: (m) => `⚠️ Compact failed: ${m}`,
    compactNoSession: "No active session to compact. Just send a message to start one.",
    compactProviderUnsupported: "/compact is currently available only with provider=claude.",
    autoCompact: "🗜️ Auto-compacted context (conversation was getting long).",
    autoCompactAsk: (n) =>
      `🗜️ Context is around ${fmtTokens(n)}, past the auto-compact threshold. Compact now?\n` +
      "Compacting replaces the conversation with a summary — details are lost, but replies get cheaper and faster.",
    autoCompactNowBtn: "🗜️ Compact now",
    autoCompactLaterBtn: "Later",
    autoCompactLater: (n) => `OK — I won't ask again until context passes ${fmtTokens(n)}.`,
    planUsage: "Usage: `/plan <request>` — e.g. `/plan add input validation to the signup form`",
    planApprove: "✅ Proceed",
    planCancel: "❌ Cancel",
    planCancelled: "❌ Plan cancelled. No changes were made.",
    planNoPending: "No pending plan to approve (it may have expired after /new). Send /plan again.",
    planProviderUnsupported: "/plan approval flow currently requires provider=claude.",
    testFallbackDisabled: "⚠️ No fallback is enabled. Set `\"codexFallback\": true` (recommended) or `\"ollamaFallback\": true` in config.json.",
    testFallbackFail: (m) => `⚠️ Fallback test failed: ${m}`,
    ollamaDisabled: "⚠️ Ollama mode is not enabled. Set `\"ollamaFallback\": true` in config.json.",
    ollamaOn: "🌙 Ollama mode on. Messages will now go to Ollama. Your Claude session is preserved.",
    ollamaOff: "✅ Ollama mode off. Back to Claude.",
    busy: "⏳ A previous task is still running. Please try again when it finishes.",
    queued: (n) => `⏳ Queued (#${n}). Will run when the current task finishes.`,
    stopOk: "🛑 Task stopped.",
    stopReset: "🛑 Task stopped and session rolled back to before the task.",
    stopNoop: "No task is running.",
    localBusy: "💻 A local `ctb` session is active. Send a message when it's done, or end it here.",
    localKillBtn: "💻 End local session",
    localActive: (pid, mins) =>
      `💻 A local \`ctb\` session is running (PID ${pid}, started ${mins}m ago).`,
    localNone: "No local `ctb` session is running.",
    localKilled: (pid) => `🛑 Ended the local \`ctb\` session (PID ${pid}).`,
    localKillFail: (pid) =>
      `⚠️ Couldn't end PID ${pid} — it may need to be closed in the terminal.`,
    needChatId: (id) => `Add this chat ID to "allowedChatId" in config.json:\n${id}`,
    cronEmpty:
      "No scheduled tasks yet.\nAdd one in plain language, e.g. `/cron add summarize open issues every weekday at 9am`.",
    cronListHeader: "⏰ Scheduled tasks",
    cronListFooter: "Add: /cron add <natural language> · Remove: /cron rm <id>",
    cronAddUsage:
      "Usage: /cron add <natural-language request>\nExample: /cron add summarize open issues every weekday at 9am",
    cronAddDone: (id, human, prompt, cron) =>
      `⏰ Registered #${id}${human ? ` — ${human}` : ""}\n"${prompt}"\n` +
      "```\n" + cron + "\n```\n" +
      `Wrong? /cron rm ${id}`,
    cronRmNotFound:
      "No scheduled task with that id. Run /cron to see the list. (config tasks are removed in the file.)",
    cronRmDone: (id, prompt) => `🗑️ Removed #${id}: ${prompt}`,
    cronUsage: "Usage: /cron · /cron add <natural language> · /cron rm <id>",
    restartChecking: "🔎 Syntax-checking bot.mjs…",
    restartSyntaxFail: (err) =>
      `⚠️ Restart canceled due to a syntax error (bot still running):\n${err}`,
    restartOk: "✅ Syntax OK · restarting… (a supervisor relaunches it, ~10s with launchd)",
    restartDone: (n) => `✅ Restarted · ${n} scheduled task(s) active`,
    restartInterrupted: (n) =>
      `♻️ The bot was restarted from another room — the task running here was interrupted` +
      (n ? ` and ${n} queued message(s) were dropped.` : ".") +
      `\nSend it again once the bot is back (~10s).`,
    attachFail: (m) => `⚠️ Failed to handle attachment: ${m}`,
    botError: (m) => `Bot error: ${m}`,
    scheduledError: (m) => `⏰ Scheduled task error: ${m}`,
    extractFail: "Extraction failed",
    extractNoUnderstand: "Couldn't understand the schedule. Try rephrasing.",
    extractBadCron: (cron) => `Couldn't parse cron: ${cron}`,
    extractNoPrompt: "Couldn't find what to run.",
    status: (i) =>
      `🤖 ${i.name}\n` +
      `• Version: ${i.version}\n` +
      `• Provider: ${i.provider}\n` +
      `• CLIs: Claude ${i.cliVersions.claude} · Codex ${i.cliVersions.codex} · Ollama ${i.cliVersions.ollama}\n` +
      `• Model: ${i.model}\n` +
      `• Fallback: ${i.fallback}\n` +
      `• Session: ${i.hasSession ? "active" : "none (fresh)"}\n` +
      `• Scheduled jobs: ${i.jobs}\n` +
      `• Project: ${i.projectDir}\n` +
      `• Permission: ${i.permissionMode}`,
    claudeModelStatus: (cur) =>
      `🧠 Claude model: ${cur}\n` +
      "Tap to switch, or send `/model <full-model-id>`",
    codexModelStatus: (cur) =>
      `🧠 Codex model: ${cur}\n` +
      "Set: `/model <full-codex-model-id>`",
    modelDefBtn: "Default",
    modelSet: (provider, m) => `🧠 ${provider} model set to: ${m}`,
    modelReset: (provider, def) => `🧠 ${provider} model reset to default (${def}).`,
    providerStatus: (cur, def) => `🤖 Provider: ${cur}${cur === def ? " (config default)" : ` (config default: ${def})`}`,
    providerDefBtn: "Config default",
    providerSet: (provider) => `🤖 Default provider set to ${provider}. Existing Claude and Codex sessions are preserved separately.`,
    providerReset: (provider) => `🤖 Provider reset to the config default (${provider}).`,
    providerUsage: "Usage: /provider claude · /provider codex · /provider default",
    autoCompactStatus: (cur, def) =>
      `🗜️ Auto-compact threshold: ${fmtTokens(cur)}${cur === def ? " (default)" : ""}\n` +
      "Tap a button below, or `/autocompact 120k`",
    autoCompactSet: (n) => `🗜️ Auto-compact threshold set to ${fmtTokens(n)}.`,
    autoCompactOff: "🗜️ Auto-compact disabled.",
    autoCompactReset: (def) => `🗜️ Auto-compact threshold reset to default (${fmtTokens(def)}).`,
    autoCompactUsage: "Usage: `/autocompact 120k` (or 120000) · `/autocompact off` · `/autocompact default`",
    autoCompactRange: (n, min, max) =>
      `⚠️ ${fmtTokens(n)} is out of range — keep it between ${fmtTokens(min)} and ${fmtTokens(max)}. ` +
      "Use `/autocompact off` to disable it instead.",
    autoCompactOffBtn: "Off",
    autoCompactDefBtn: "Default",
    memoryEmpty: "No memory yet. Use `/remember <text>` to add.",
    memoryShow: (m) => `💾 Memory:\n\`\`\`\n${m}\n\`\`\``,
    memoryCleared: "🧹 Memory cleared.",
    remembered: "💾 Saved to memory.",
    rememberUsage: "Usage: /remember <text to remember>",
    memoryUsage: "Usage: /memory · /memory clear",
    rateLimitQueued: (n, time) => `⏳ Queued (#${n}). Will retry at ${time}. /reserve rm to cancel.`,
    reserveStatus: (n, time) => `⏳ ${n} message(s) queued. Retrying at ${time}. /reserve rm to cancel.`,
    reserveAuto: (time) => `⏰ Auto-retry scheduled for ${time}. Cancel with /reserve rm.`,
    reserveRm: "🚫 Queue cleared. No retry scheduled.",
    reserveNone: "No retry is scheduled.",
    contextTooLong: "⚠️ Prompt is too long. Use `/compact` to compress context, or `/new` to start fresh.",
  },
  ko: {
    help: () =>
      `${cfg.name || "Claude Code 텔레그램 봇"}\n\n` +
      "• 그냥 메시지를 보내면 Claude가 프로젝트에서 작업합니다.\n" +
      "• 메시지를 // 로 시작하면 봇이 무시합니다 — 채팅에 혼잣말 메모를 남기는 용도\n" +
      "• /new — 대화 맥락 초기화 (새 세션)\n" +
      "• /compact — 컨텍스트 압축 (세션 유지, 공간 확보)\n" +
      "• /plan <요청> — 계획만 세우기 (편집 없음) → 승인/취소로 실제 실행\n" +
      "• Codex 폴백 활성화 시 Claude 한도 도달 때 자동으로 대신 실행\n" +
      "• /ollama — Ollama 채팅 모드 토글 (Claude 우회, 로컬 LLM 사용)\n" +
      "• /stop — 진행 중인 작업 중단 · /stop --reset 으로 세션도 되돌리기\n" +
      "• /local — 로컬 `ctb` 세션 상태 확인 · 봇을 막고 있으면 여기서 종료\n" +
      "• /cron — 예약 작업 보기 · /cron add <자연어>로 추가 · /cron rm <번호>로 삭제\n" +
      "• /remember <내용> — 퍼시스턴트 메모리에 저장 (/new 로 초기화해도 유지)\n" +
      "• /memory — 메모리 보기 · /memory clear 로 삭제\n" +
      "• /reserve — 한도 리셋 시 대기열 상태 확인 · /reserve rm 으로 취소\n" +
      "• /restart — 봇 재시작 (문법 검사 후 안전하게)\n" +
      "• /status — 봇 상태·버전 보기\n" +
      "• /provider — 기본 provider 보기·전환\n" +
      "• /model — 모델 보기·전환\n" +
      "• /autocompact — 자동 압축 임계값 보기·설정\n" +
      "• /id — 이 채팅 ID 확인\n" +
      `\n작업 폴더: ${cfg.projectDir}\n권한 모드: ${cfg.permissionMode}`,
    newSession: "🆕 새 대화를 시작합니다 (이전 맥락 초기화).",
    busy: "⏳ 이전 작업이 아직 진행 중입니다. 끝나면 다시 보내주세요.",
    queued: (n) => `⏳ 대기열에 추가됐습니다 (${n}번째). 현재 작업이 끝나면 자동으로 실행됩니다.`,
    stopOk: "🛑 작업을 중단했습니다.",
    stopReset: "🛑 작업을 중단하고 세션을 작업 이전으로 되돌렸습니다.",
    stopNoop: "실행 중인 작업이 없습니다.",
    localBusy: "💻 로컬 `ctb` 세션이 활성화되어 있습니다. 종료 후 메시지를 보내거나, 여기서 종료하세요.",
    localKillBtn: "💻 로컬 세션 종료",
    localActive: (pid, mins) =>
      `💻 로컬 \`ctb\` 세션이 실행 중입니다 (PID ${pid}, ${mins}분 전 시작).`,
    localNone: "실행 중인 로컬 `ctb` 세션이 없습니다.",
    localKilled: (pid) => `🛑 로컬 \`ctb\` 세션을 종료했습니다 (PID ${pid}).`,
    localKillFail: (pid) => `⚠️ PID ${pid} 를 종료하지 못했습니다 — 터미널에서 직접 닫아야 할 수 있습니다.`,
    needChatId: (id) => `이 채팅 ID를 config.json 의 allowedChatId 에 넣으세요:\n${id}`,
    cronEmpty:
      "등록된 예약 작업이 없습니다.\n`/cron add 매일 아침 9시에 …` 처럼 자연어로 추가해 보세요.",
    cronListHeader: "⏰ 예약 작업",
    cronListFooter: "추가: /cron add <자연어> · 삭제: /cron rm <번호>",
    cronAddUsage:
      "사용법: /cron add <자연어 요청>\n예: /cron add 매일 아침 9시에 열린 이슈 요약해줘",
    cronAddDone: (id, human, prompt, cron) =>
      `⏰ 등록됨 #${id}${human ? ` — ${human}` : ""}\n"${prompt}"\n` +
      "```\n" + cron + "\n```\n" +
      `틀렸으면 /cron rm ${id}`,
    cronRmNotFound:
      "그 번호의 예약 작업이 없어요. /cron 으로 목록을 확인하세요. (config 작업은 파일에서 지워야 합니다)",
    cronRmDone: (id, prompt) => `🗑️ 삭제됨 #${id}: ${prompt}`,
    cronUsage: "사용법: /cron · /cron add <자연어> · /cron rm <번호>",
    restartChecking: "🔎 bot.mjs 문법 검사 중…",
    restartSyntaxFail: (err) => `⚠️ 문법 오류로 재시작 취소(봇은 계속 실행 중):\n${err}`,
    restartOk: "✅ 문법 OK · 재시작합니다… (관리자가 다시 띄웁니다, launchd 기준 ~10초)",
    restartDone: (n) => `✅ 재시작 완료 · 예약 작업 ${n}개 활성`,
    restartInterrupted: (n) =>
      `♻️ 다른 방에서 봇을 재시작해 여기서 실행 중이던 작업이 중단됐습니다` +
      (n ? ` (대기 중이던 메시지 ${n}개도 사라졌습니다).` : ".") +
      `\n봇이 다시 뜨면(~10초) 다시 보내주세요.`,
    attachFail: (m) => `⚠️ 첨부 파일 처리 실패: ${m}`,
    botError: (m) => `봇 오류: ${m}`,
    scheduledError: (m) => `⏰ 예약 작업 오류: ${m}`,
    extractFail: "추출 실패",
    extractNoUnderstand: "일정을 이해하지 못했어요. 다르게 표현해 보세요.",
    extractBadCron: (cron) => `cron 해석 실패: ${cron}`,
    extractNoPrompt: "무엇을 실행할지 찾지 못했어요.",
    status: (i) =>
      `🤖 ${i.name}\n` +
      `• 버전: ${i.version}\n` +
      `• 메인 provider: ${i.provider}\n` +
      `• CLI: Claude ${i.cliVersions.claude} · Codex ${i.cliVersions.codex} · Ollama ${i.cliVersions.ollama}\n` +
      `• 모델: ${i.model}\n` +
      `• 폴백: ${i.fallback}\n` +
      `• 세션: ${i.hasSession ? "이어가는 중" : "없음 (새 세션)"}\n` +
      `• 예약 작업: ${i.jobs}개\n` +
      `• 작업 폴더: ${i.projectDir}\n` +
      `• 권한 모드: ${i.permissionMode}`,
    claudeModelStatus: (cur) =>
      `🧠 현재 Claude 모델: ${cur}\n` +
      "버튼으로 전환하거나 `/model <전체 모델 ID>`",
    codexModelStatus: (cur) =>
      `🧠 현재 Codex 모델: ${cur}\n` +
      "설정: `/model <Codex 전체 모델 ID>`",
    modelDefBtn: "기본값",
    modelSet: (provider, m) => `🧠 ${provider} 모델을 ${m}(으)로 설정했습니다.`,
    modelReset: (provider, def) => `🧠 ${provider} 모델을 기본값(${def})으로 되돌렸습니다.`,
    providerStatus: (cur, def) => `🤖 현재 provider: ${cur}${cur === def ? " (config 기본값)" : ` (config 기본값: ${def})`}`,
    providerDefBtn: "config 기본값",
    providerSet: (provider) => `🤖 기본 provider를 ${provider}(으)로 변경했습니다. Claude와 Codex의 기존 세션은 각각 유지됩니다.`,
    providerReset: (provider) => `🤖 provider를 config 기본값(${provider})으로 되돌렸습니다.`,
    providerUsage: "사용법: /provider claude · /provider codex · /provider default",
    autoCompactStatus: (cur, def) =>
      `🗜️ 자동 압축 임계값: ${fmtTokens(cur, "ko")}${cur === def ? " (기본값)" : ""}\n` +
      "아래 버튼을 누르거나 `/autocompact 120k`",
    autoCompactSet: (n) => `🗜️ 자동 압축 임계값을 ${fmtTokens(n, "ko")}으로 설정했습니다.`,
    autoCompactOff: "🗜️ 자동 압축을 껐습니다.",
    autoCompactReset: (def) => `🗜️ 자동 압축 임계값을 기본값(${fmtTokens(def, "ko")})으로 되돌렸습니다.`,
    autoCompactUsage: "사용법: `/autocompact 120k` (또는 120000) · `/autocompact off` · `/autocompact default`",
    autoCompactRange: (n, min, max) =>
      `⚠️ ${fmtTokens(n, "ko")}은 범위를 벗어났습니다 — ${fmtTokens(min, "ko")}에서 ${fmtTokens(max, "ko")} 사이로 넣어주세요. ` +
      "끄려면 `/autocompact off`를 쓰세요.",
    autoCompactOffBtn: "끄기",
    autoCompactDefBtn: "기본값",
    memoryEmpty: "저장된 메모리가 없습니다. `/remember <내용>`으로 추가하세요.",
    memoryShow: (m) => `💾 메모리:\n\`\`\`\n${m}\n\`\`\``,
    memoryCleared: "🧹 메모리를 삭제했습니다.",
    remembered: "💾 메모리에 저장했습니다.",
    rememberUsage: "사용법: /remember <기억할 내용>",
    memoryUsage: "사용법: /memory · /memory clear",
    rateLimitQueued: (n, time) => `⏳ 대기열에 추가됨 (${n}번째). ${time}에 자동 재시도. 취소: /reserve rm`,
    reserveStatus: (n, time) => `⏳ 대기 중인 메시지 ${n}개. ${time}에 재시도 예약됨. 취소: /reserve rm`,
    reserveAuto: (time) => `⏰ ${time}에 자동 재시도 예약됨. 취소: /reserve rm`,
    reserveRm: "🚫 대기열을 비웠습니다. 예약 취소됨.",
    reserveNone: "예약된 재시도가 없습니다.",
    compacting: "🗜️ 압축 중… 1~2분 걸릴 수 있습니다.",
    compactOk: "🗜️ 컨텍스트를 압축했습니다. 대화가 요약본으로 이어집니다.",
    compactFail: (m) => `⚠️ compact 실패: ${m}`,
    compactNoSession: "압축할 활성 세션이 없습니다. 메시지를 보내 세션을 시작하세요.",
    compactProviderUnsupported: "/compact는 현재 provider=claude에서만 사용할 수 있습니다.",
    autoCompact: "🗜️ 대화가 길어져 컨텍스트를 자동 압축했습니다.",
    autoCompactAsk: (n) =>
      `🗜️ 컨텍스트가 ${fmtTokens(n, "ko")} 정도로 자동 압축 임계값을 넘었습니다. 지금 압축할까요?\n` +
      "압축하면 대화가 요약본으로 바뀝니다 — 세부 내용은 사라지지만 응답이 싸고 빨라집니다.",
    autoCompactNowBtn: "🗜️ 지금 압축",
    autoCompactLaterBtn: "나중에",
    autoCompactLater: (n) => `알겠습니다 — 컨텍스트가 ${fmtTokens(n, "ko")}을 넘기 전까지 다시 묻지 않습니다.`,
    planUsage: "사용법: `/plan <요청>` — 예: `/plan 회원가입 폼에 입력값 검증 추가해줘`",
    planApprove: "✅ 진행",
    planCancel: "❌ 취소",
    planCancelled: "❌ 계획을 취소했습니다. 아무 변경도 없습니다.",
    planNoPending: "승인할 계획이 없습니다 (/new 이후 만료됐을 수 있음). /plan 을 다시 보내세요.",
    planProviderUnsupported: "/plan 승인 흐름은 현재 provider=claude에서만 사용할 수 있습니다.",
    contextTooLong: "⚠️ 프롬프트가 너무 깁니다. `/compact` 로 컨텍스트를 압축하거나 `/new` 로 새 세션을 시작하세요.",
    testFallbackDisabled: "⚠️ 폴백이 비활성화 상태입니다. config.json에 `\"codexFallback\": true`(권장) 또는 `\"ollamaFallback\": true` 를 추가하세요.",
    testFallbackFail: (m) => `⚠️ 폴백 테스트 실패: ${m}`,
    ollamaDisabled: "⚠️ Ollama 모드가 비활성화 상태입니다. config.json에 `\"ollamaFallback\": true` 를 추가하세요.",
    ollamaOn: "🌙 Ollama 모드 켜짐. 이제 메시지는 Ollama로 처리됩니다. Claude 세션은 유지됩니다.",
    ollamaOff: "✅ Ollama 모드 꺼짐. 다시 Claude로 처리합니다.",
  },
};
const t = (l, key, ...a) => {
  const v = (STR[l] || STR.en)[key];
  return typeof v === "function" ? v(...a) : v;
};

// 토큰 수 표기·입력 — 모바일에서 0 여섯 개를 치는 건 번거로우니 120k / 1.5m 축약을 받는다.
function fmtTokens(n, l = "en") {
  if (!n) return l === "ko" ? "꺼짐" : "off";
  const num =
    n >= 1e6 && n % 1e5 === 0 ? `${n / 1e6}m` : n % 1000 === 0 ? `${n / 1000}k` : String(n);
  return l === "ko" ? `${num} 토큰` : `${num} tokens`;
}
function parseTokens(raw) {
  const m = String(raw).replace(/[,_\s]/g, "").match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!m) return NaN;
  const mult = m[2] ? (m[2].toLowerCase() === "k" ? 1000 : 1000000) : 1;
  return Math.round(Number(m[1]) * mult);
}

// /model 에서 보여줄 추천 별칭(claude CLI 가 별칭·전체 모델 ID 모두 허용).
const CLAUDE_MODEL_SUGGESTIONS = ["fable", "opus", "sonnet", "haiku"];

// /(슬래시) 자동완성 메뉴용 명령 목록 (언어별). setMyCommands 로 등록.
const COMMANDS = {
  en: [
    { command: "new", description: "Reset context (new session)" },
    { command: "compact", description: "Compress context to free up space (keeps session)" },
    { command: "plan", description: "Plan only (no edits), then approve/cancel to run for real" },
    { command: "ollama", description: "Toggle Ollama chat mode (bypass Claude, use local LLM)" },
    { command: "stop", description: "Stop the current task (--reset to roll back session)" },
    { command: "local", description: "Local ctb session status · end it from here" },
    { command: "remember", description: "Save to persistent memory (survives /new)" },
    { command: "memory", description: "View or clear persistent memory" },
    { command: "cron", description: "List / add / remove scheduled tasks" },
    { command: "restart", description: "Restart the bot (after syntax check)" },
    { command: "status", description: "Bot status / version" },
    { command: "provider", description: "View / switch the default provider" },
    { command: "model", description: "View / switch the model" },
    { command: "autocompact", description: "View / set the auto-compact token threshold" },
    { command: "reserve", description: "Schedule retry when usage limit resets · /reserve rm to cancel" },
    { command: "id", description: "Show this chat ID" },
    { command: "help", description: "Help" },
  ],
  ko: [
    { command: "new", description: "대화 맥락 초기화 (새 세션)" },
    { command: "compact", description: "컨텍스트 압축 (세션 유지, 공간 확보)" },
    { command: "plan", description: "계획만 세우기 (편집 없음) → 승인/취소로 실제 실행" },
    { command: "ollama", description: "Ollama 채팅 모드 토글 (Claude 우회, 로컬 LLM)" },
    { command: "stop", description: "작업 중단 (--reset 으로 세션 되돌리기)" },
    { command: "local", description: "로컬 ctb 세션 상태 확인·종료" },
    { command: "remember", description: "퍼시스턴트 메모리에 저장 (/new 후에도 유지)" },
    { command: "memory", description: "메모리 보기·삭제" },
    { command: "cron", description: "예약 작업 보기·추가·삭제" },
    { command: "restart", description: "봇 재시작 (문법 검사 후)" },
    { command: "status", description: "봇 상태·버전 보기" },
    { command: "provider", description: "기본 provider 보기·전환" },
    { command: "model", description: "모델 보기·전환" },
    { command: "autocompact", description: "자동 압축 임계값 보기·설정" },
    { command: "reserve", description: "한도 리셋 시 재시도 예약 · /reserve rm 으로 취소" },
    { command: "id", description: "이 채팅 ID 확인" },
    { command: "help", description: "도움말" },
  ],
};

// ── 로컬 세션 lock ────────────────────────────────────────────────────────
// ctb claude 실행 시 .claude-bot/local.lock (PID) 을 생성하고 종료 시 삭제.
// 봇은 claude 실행 전 이 파일을 확인해 동시 실행을 방지한다.
// PID 가 이미 종료된 경우(stale lock) 자동 제거 후 진행.
const LOCAL_LOCK_PATH = join(BOT_DIR, "local.lock");
function checkLocalLock() {
  if (!existsSync(LOCAL_LOCK_PATH)) return false;
  try {
    const pid = parseInt(readFileSync(LOCAL_LOCK_PATH, "utf8"), 10);
    process.kill(pid, 0); // throws if process is dead
    return true; // lock is valid
  } catch {
    try { unlinkSync(LOCAL_LOCK_PATH); } catch {} // stale — remove
    return false;
  }
}
// 로컬 세션 정보 — lock 파일의 PID·생성 시각(경과 분).
function localLockInfo() {
  if (!checkLocalLock()) return null;
  try {
    const pid = parseInt(readFileSync(LOCAL_LOCK_PATH, "utf8"), 10);
    const mins = Math.max(0, Math.round((Date.now() - statSync(LOCAL_LOCK_PATH).mtimeMs) / 60000));
    return { pid, mins };
  } catch {
    return null;
  }
}
// 로컬 세션 강제 종료 — 밖에 나와 있는데 데스크탑에 ctb 를 켜둔 채였을 때 텔레그램에서 끝낸다.
// ctb 는 셸 잡 컨트롤 아래에서 프로세스 그룹 리더라 그룹(-pid)에 신호를 보내야 자식 claude 까지
// 함께 받는다 — Ctrl-C 와 같은 경로라 ctb 가 lock 정리·세션 요약 알림까지 정상 수행한다.
// 그룹 전송이 안 되면(pgid ≠ pid) PID 로 직접 보낸다.
async function killLocalSession() {
  const info = localLockInfo();
  if (!info) return { none: true };
  const signal = (sig) => {
    try { process.kill(-info.pid, sig); return true; } catch {}
    try { process.kill(info.pid, sig); return true; } catch {}
    return false;
  };
  if (!signal("SIGTERM")) return { ok: false, pid: info.pid };
  // ctb 는 자식이 끝난 뒤 lock 을 지우므로 잠시 기다리고, 그래도 살아 있으면 SIGKILL.
  for (let i = 0; i < 20; i++) {
    if (!checkLocalLock()) return { ok: true, pid: info.pid };
    await new Promise((r) => setTimeout(r, 250));
  }
  signal("SIGKILL");
  for (let i = 0; i < 8; i++) {
    if (!checkLocalLock()) return { ok: true, pid: info.pid, forced: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, pid: info.pid };
}

// ── npm 최신 버전 확인 ────────────────────────────────────────────────────
// /status 호출 및 시작 시 24h 주기 업데이트 감지에 사용.
const VERSION_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24h

async function fetchLatestVersion() {
  try {
    const r = await fetch("https://registry.npmjs.org/claude-telegram-bot/latest", {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    return (await r.json()).version || null;
  } catch {
    return null;
  }
}

// 버전 비교: "1.2.3" > "1.2.2" 형태의 semver 대소 비교 (major.minor.patch).
function isNewer(latest, current) {
  const p = (v) => String(v).split(".").map(Number);
  const [lM, lm, lp] = p(latest);
  const [cM, cm, cp] = p(current);
  return lM !== cM ? lM > cM : lm !== cm ? lm > cm : lp > cp;
}

async function checkForUpdate() {
  if (!allowedIds.length) return;
  const now = Date.now();
  if (state.lastVersionCheck && now - state.lastVersionCheck < VERSION_CHECK_INTERVAL) return;
  const latest = await fetchLatestVersion();
  state.lastVersionCheck = now;
  saveState(state);
  if (!latest || !isNewer(latest, VERSION)) return;
  if (state.notifiedVersion === latest) return; // 이미 알린 버전
  state.notifiedVersion = latest;
  saveState(state);
  for (const id of allowedIds)
    await send(id,
      `✨ 업데이트가 있습니다: ${VERSION} → ${latest}\n\`npm i -g claude-telegram-bot\` 후 /restart`
    ).catch(() => {});
}

// ── 퍼시스턴트 메모리 ─────────────────────────────────────────────────────
// /new 로 세션을 초기화해도 유지되는 메모리. runClaude 시 시스템 프롬프트에 주입.
function loadMemory() {
  try { return readFileSync(MEMORY_PATH, "utf8").trim(); } catch { return ""; }
}
function saveMemory(content) {
  writeFileSync(MEMORY_PATH, content);
}

function loadCodexHandoff(maxChars = 12000) {
  try {
    const text = readFileSync(CODEX_HANDOFF_PATH, "utf8").trim();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return "";
  }
}

function appendCodexHandoff({ prompt, response, sessionId }) {
  const entry =
    `\n\n## ${new Date().toISOString()}\n` +
    `Codex session: ${sessionId || "(unknown)"}\n\n` +
    `### Telegram prompt\n${String(prompt || "").trim() || "(empty)"}\n\n` +
    `### Codex response\n${String(response || "").trim() || "(empty)"}\n`;
  try {
    writeFileSync(CODEX_HANDOFF_PATH, loadCodexHandoff(80000) + entry);
  } catch (e) {
    console.error("Failed to append Codex handoff", e.message);
  }
}

// ── 상태 (세션 이어가기용) ────────────────────────────────────────────────
function loadState() {
  // 새 경로(.claude-bot/) 우선, 없으면 구버전 루트 경로로 폴백(이주 실패 시 안전망).
  for (const p of [STATE_PATH, LEGACY_STATE_PATH]) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {}
  }
  return {};
}
function saveState(s) {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error("Failed to save state", e);
  }
}
migrateData(); // 루트 직하 → .claude-bot/ 1회 이주(있으면) 후 state 로드
let state = loadState(); // { sessionId?, codexSessionId?, cron?: [{ id, cron, prompt, label? }], restartNotify?, model? }
if (state.provider && !["claude", "codex"].includes(state.provider)) {
  console.warn(`Ignoring invalid provider override in state: ${state.provider}`);
  state.provider = undefined;
}
const currentProvider = () => state.provider || DEFAULT_PROVIDER;

// ── 방(chatId)별 세션 ─────────────────────────────────────────────────────
// 같은 봇이 여러 방(DM·그룹)을 담당할 때 방마다 대화 맥락을 분리한다. Claude와 Codex 세션은
// 서로 호환되지 않으므로 방마다 sessionId(Claude)와 codexSessionId(Codex)를 따로 저장한다.
// provider·model·ollamaMode 같은 봇 단위 설정은 기존대로 state 최상위에 둔다(세션만 방별로 분리).
function chatBucket(chatId) {
  if (!state.sessions) state.sessions = {};
  const k = String(chatId);
  if (!state.sessions[k]) state.sessions[k] = {};
  return state.sessions[k];
}
const sidKey = (provider = currentProvider()) => (provider === "codex" ? "codexSessionId" : "sessionId");
function getSid(chatId, provider = currentProvider()) {
  return chatBucket(chatId)[sidKey(provider)];
}
function setSid(chatId, id, provider = currentProvider()) {
  chatBucket(chatId)[sidKey(provider)] = id;
}

// 구버전(전역 단일 세션) → 방별 세션 마이그레이션. 어느 방의 세션인지 알 수 없으므로 주(primary)
// 방(allowedIds[0], 보통 소유자 DM)으로 옮긴다. allowedChatId 미설정 시엔 메시지 처리 자체가
// 안 되므로 그대로 두고, chatId가 생긴 뒤 재시작 때 이관된다.
if (!state.sessions && (state.sessionId || state.codexSessionId)) {
  const primary = allowedIds[0];
  if (primary) {
    state.sessions = { [primary]: {} };
    if (state.sessionId) state.sessions[primary].sessionId = state.sessionId;
    if (state.codexSessionId) state.sessions[primary].codexSessionId = state.codexSessionId;
    delete state.sessionId;
    delete state.codexSessionId;
    saveState(state);
  }
}

// ── 텔레그램 헬퍼 ─────────────────────────────────────────────────────────
let botUsername = ""; // 시작 시 getMe 로 채움

// 그룹 채팅에서 텔레그램은 명령어를 `/cmd@BotName` 형태로 보낸다.
// 내 봇을 향한 것이면 `@BotName` 을 떼어 일반 명령어 파싱에 태운다.
// 다른 봇을 향한 명령어(`/cmd@OtherBot`)는 건드리지 않는다.
function stripBotMention(text) {
  if (!text.startsWith("/")) return text;
  const sp = text.indexOf(" ");
  const head = sp === -1 ? text : text.slice(0, sp);
  const at = head.indexOf("@");
  if (at === -1) return text;
  if (botUsername && head.slice(at + 1).toLowerCase() !== botUsername.toLowerCase()) return text;
  return head.slice(0, at) + (sp === -1 ? "" : text.slice(sp));
}

async function tg(method, body) {
  const r = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

function* chunks(text, size = 3800) {
  let t = String(text ?? "");
  if (t.length === 0) {
    yield "(empty response)";
    return;
  }
  while (t.length > 0) {
    if (t.length <= size) {
      yield t;
      return;
    }
    // 가능하면 줄바꿈 경계에서 자르기
    let cut = t.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    yield t.slice(0, cut);
    t = t.slice(cut);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// GitHub-flavored Markdown → Telegram-safe HTML (subset Telegram supports).
// Telegram only allows a few tags; anything malformed makes the API reject the
// message, so send() falls back to plain text on error.
function mdToTelegramHtml(md) {
  let text = String(md ?? "");
  const codeBlocks = [];
  text = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => {
    const i = codeBlocks.length;
    codeBlocks.push("<pre>" + escapeHtml(code.replace(/\n$/, "")) + "</pre>");
    return ` CB${i} `;
  });

  const inline = (line) => {
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    let body = h ? h[1] : line;
    body = body.replace(/^(\s*)[-*+]\s+/, "$1• "); // bullets
    body = escapeHtml(body);
    body = body.replace(/`([^`]+)`/g, "<code>$1</code>");
    body = body.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__([^_]+)__/g, "<b>$1</b>");
    body = body.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
    body = body.replace(/~~([^~]+)~~/g, "<s>$1</s>");
    body = body.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u.replace(/"/g, "%22")}">${t}</a>`);
    return h ? "<b>" + body + "</b>" : body;
  };

  const out = [];
  let table = [];
  const flushTable = () => {
    if (!table.length) return;
    const rows = table
      .filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)) // drop ---|--- separator
      .map((r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()).join(" | "));
    out.push("<pre>" + escapeHtml(rows.join("\n")) + "</pre>");
    table = [];
  };
  for (const raw of text.split("\n")) {
    if (raw.trim().startsWith("|") && raw.includes("|")) { table.push(raw); continue; }
    flushTable();
    // 한 줄 전체가 인라인 코드(`...`)면 <pre> 블록으로 → 텔레그램 복사 버튼이 붙어 명령어 복사 편함.
    // 문장 중간 인라인 코드는 그대로 <code> 유지.
    const only = raw.trim().match(/^`([^`]+)`$/);
    if (only) { out.push("<pre>" + escapeHtml(only[1]) + "</pre>"); continue; }
    out.push(inline(raw));
  }
  flushTable();

  return out.join("\n").replace(/ CB(\d+) /g, (_, i) => codeBlocks[Number(i)]);
}

// opts.replyMarkup: 인라인 키보드 — 여러 청크로 나뉘면 마지막 청크에만 붙음.
// 반환값: 마지막으로 보낸 메시지의 message_id (버튼 클릭 후 편집용, 실패 시 null).
async function send(chatId, text, opts = {}) {
  const cs = [...chunks(text)];
  let lastId = null;
  for (let i = 0; i < cs.length; i++) {
    const isLast = i === cs.length - 1;
    const body = {
      chat_id: chatId,
      text: mdToTelegramHtml(cs[i]),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (isLast && opts.replyMarkup) body.reply_markup = opts.replyMarkup;
    let r = await tg("sendMessage", body);
    // If our HTML is malformed for some edge case, resend as plain text.
    if (!r || r.ok === false) {
      const plain = { chat_id: chatId, text: cs[i], disable_web_page_preview: true };
      if (isLast && opts.replyMarkup) plain.reply_markup = opts.replyMarkup;
      r = await tg("sendMessage", plain);
    }
    if (r?.ok) lastId = r.result?.message_id;
  }
  return lastId;
}

// ── 이미지 전송(아웃박스) ──────────────────────────────────────────────────
// multipart/form-data 로 sendPhoto (Node 18+ 내장 FormData/Blob, 의존성 0 유지).
async function tgSendPhoto(chatId, absPath, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) fd.append("caption", caption.slice(0, 1024));
  fd.append("photo", new Blob([readFileSync(absPath)]), basename(absPath));
  const r = await fetch(`${TG}/sendPhoto`, { method: "POST", body: fd });
  return r.json();
}

// 마커의 파일명을 검증한다. basename만 취해 경로탈출을 원천 차단하고, 반드시 OUTBOX_DIR 안의
// 실제 파일이며 허용 확장자·크기여야 한다. 실패 시 null(전송 안 함).
function validateOutboxImage(rawName, rawCap) {
  try {
    const name = basename(String(rawName).trim());
    if (!name || name.startsWith(".")) return null;
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    if (!OUTBOX_EXT.has(ext)) { console.warn(`Outbox: unsupported type ${name}`); return null; }
    const abs = join(OUTBOX_DIR, name);
    if (!existsSync(abs)) { console.warn(`Outbox: file not found ${name}`); return null; }
    const st = statSync(abs);
    if (!st.isFile()) return null;
    if (st.size > OUTBOX_MAX_BYTES) { console.warn(`Outbox: too large ${name} (${st.size}B)`); return null; }
    // 심볼릭 링크로 폴더 밖을 가리키는 경우 차단
    const realOut = realpathSync(OUTBOX_DIR);
    const real = realpathSync(abs);
    if (real !== realOut && !real.startsWith(realOut + sep)) { console.warn(`Outbox: escapes dir ${name}`); return null; }
    const caption = rawCap ? String(rawCap).trim().slice(0, 1024) || undefined : undefined;
    return { name, abs: real, caption };
  } catch (e) {
    console.warn("Outbox validate error:", e.message);
    return null;
  }
}

// 답변 텍스트에서 [[ctb-image: 파일명 | 캡션]] 마커를 뽑아내고, 마커는 텍스트에서 제거한다.
const OUTBOX_MARKER = /\[\[ctb-image:\s*([^\]|]+?)\s*(?:\|\s*([^\]]*?))?\s*\]\]/g;
function extractOutboxImages(text) {
  const images = [];
  if (!IMAGE_SEND || !text || !text.includes("[[ctb-image:")) return { text: text || "", images };
  const clean = String(text)
    .replace(OUTBOX_MARKER, (_m, name, cap) => {
      const img = validateOutboxImage(name, cap);
      if (img) images.push(img);
      return ""; // 유효하든 아니든 마커 자체는 사용자에게 노출하지 않는다
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: clean, images };
}

// 에이전트 답변을 사용자에게 전달한다. 이미지 마커가 있으면 텍스트(마커 제거)를 먼저,
// 이어서 사진을 보낸다. 마커가 없으면 기존 send() 와 완전히 동일하게 동작한다.
async function deliver(chatId, text, opts = {}) {
  const { text: clean, images } = extractOutboxImages(text);
  let lastId = null;
  // 텍스트가 남아 있거나(정상) 보낼 이미지가 없으면 텍스트를 보낸다.
  // 이미지만 있고 본문이 빈 경우엔 "(empty response)" 버블을 만들지 않도록 텍스트 전송을 건너뛴다.
  if (clean.trim() || images.length === 0) lastId = await send(chatId, clean, opts);
  for (const img of images) {
    try {
      const r = await tgSendPhoto(chatId, img.abs, img.caption);
      if (!r?.ok) console.error(`sendPhoto failed (${img.name}):`, r?.description);
    } catch (e) {
      console.error(`sendPhoto error (${img.name}):`, e.message);
    }
  }
  return lastId;
}

// 에이전트에게 이미지 전송법을 알려주는 시스템 프롬프트 조각.
function imageSendInstruction() {
  return `To send an image to this Telegram chat: save the image file into the folder ${OUTBOX_DIR} `
    + `(bare filename, no subfolders), then add a line at the very END of your reply in this exact form:\n`
    + `[[ctb-image: FILENAME | optional caption]]\n`
    + `Use only the filename (e.g. chart.png), not a path. Repeat the line for multiple images. `
    + `Supported: png, jpg, jpeg, gif, webp, up to 10 MB each. The marker line is stripped from your `
    + `visible reply and the file is delivered as a Telegram photo. Only do this when the user wants an image.`;
}

// ── Claude 에러 분류 ──────────────────────────────────────────────────────
function parseResetTime(raw) {
  // ISO timestamp: 2026-06-17T14:00:00Z
  const iso = raw.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/);
  if (iso) { const d = new Date(iso[0]); if (!isNaN(d)) return d; }
  // "in X minutes" / "in X hours"
  const inMin = raw.match(/in (\d+)\s*minute/i);
  if (inMin) return new Date(Date.now() + parseInt(inMin[1]) * 60000);
  const inHour = raw.match(/in (\d+)\s*hour/i);
  if (inHour) return new Date(Date.now() + parseInt(inHour[1]) * 3600000);
  // "resets at HH:MM" / "resets HH:MM" / "available at HH:MM"
  const atTime = raw.match(/(?:resets?|available|retry)(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (atTime) {
    let h = parseInt(atTime[1]);
    const m = parseInt(atTime[2]);
    if (atTime[3]) { if (/pm/i.test(atTime[3]) && h < 12) h += 12; if (/am/i.test(atTime[3]) && h === 12) h = 0; }
    const d = new Date(); d.setHours(h, m, 0, 0);
    if (d <= new Date()) d.setDate(d.getDate() + 1);
    return d;
  }
  return null;
}

function isFallbackError(raw, code) {
  const t = (raw || "").toLowerCase();
  return t.includes("credit") || t.includes("balance") || t.includes("billing") || t.includes("payment")
    || t.includes("rate_limit") || t.includes("rate limit") || t.includes("too many requests") || code === 429
    || t.includes("usage limit") || t.includes("monthly limit") || t.includes("session limit")
    || t.includes("overloaded") || code === 529;
}

function classifyClaudeError(raw, code) {
  const t = raw.toLowerCase();
  if (t.includes("credit") || t.includes("balance") || t.includes("billing") || t.includes("payment"))
    return "💳 API 크레딧이 부족합니다. console.anthropic.com 에서 충전해주세요.";
  if (t.includes("rate_limit") || t.includes("rate limit") || t.includes("too many requests") || code === 429
      || t.includes("usage limit") || t.includes("monthly limit") || t.includes("session limit"))
    return "⏱️ 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.";
  if (t.includes("overloaded") || code === 529)
    return "🔄 Claude 서버가 일시적으로 과부하 상태입니다. 잠시 후 다시 시도해주세요.";
  if (t.includes("prompt is too long") || (t.includes("context") && (t.includes("length") || t.includes("limit") || t.includes("window"))))
    return "contextTooLong";
  return `Execution error (exit ${code}):\n${raw}`;
}

// ── 커스텀 명령어 스크립트 실행 ──────────────────────────────────────────
function runCustomCommand(run, args) {
  return new Promise((resolve) => {
    const cmd = args ? `${run} ${args}` : run;
    const child = spawn(cmd, [], {
      shell: true,
      cwd: cfg.projectDir,
      env: { ...process.env, ...(cfg.env || {}) },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      const text = (out + (err ? `\n[stderr]\n${err}` : "")).trim() || "(no output)";
      resolve({ ok: code === 0, text, code });
    });
    child.on("error", (e) => resolve({ ok: false, text: e.message, code: -1 }));
    setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, text: "timeout (60s)", code: -1 }); }, 60_000);
  });
}

// 한 턴의 usage 에서 "지금 컨텍스트에 얼마나 쌓였나"를 추정한다.
// 주의: usage.cache_read_input_tokens 는 컨텍스트 크기가 아니라 그 턴 안에서 일어난 모든 API
// 호출의 합계다. 도구를 쓸 때마다 컨텍스트를 통째로 다시 읽으므로 도구 호출 수에 비례해 부풀고,
// 실제로는 30k 짜리 대화가 파일 5개를 읽었다는 이유로 160k 로 잡힌다(측정 확인).
// 마지막 호출(usage.iterations 의 끝 항목)의 입력 토큰 합이 그 시점의 실제 컨텍스트 크기다.
// iterations 가 없는 CLI 버전에서는 턴 수로 나눠 근사한다 — 과소평가 쪽이라 덜 압축하게 된다.
function ctxTokensOf(usage, numTurns) {
  if (!usage) return 0;
  const it = usage.iterations;
  const last = Array.isArray(it) && it.length ? it[it.length - 1] : null;
  if (last) {
    return (last.cache_read_input_tokens || 0) + (last.cache_creation_input_tokens || 0) + (last.input_tokens || 0);
  }
  const total = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return Math.round(total / Math.max(numTurns || 1, 1));
}

// ── Claude 실행 ───────────────────────────────────────────────────────────
function runClaude(prompt, sessionId, opts = {}) {
  return new Promise((resolve) => {
    const args = [
      "--output-format", "json",
      "--permission-mode", opts.permissionMode || cfg.permissionMode || "acceptEdits",
    ];
    const model = state.model || cfg.model; // /model 로 바꾸면 state.model 우선
    const brevity =
      cfg.appendSystemPrompt ??
      "This reply is delivered over Telegram. Be concise — short paragraphs and lists, no filler intro/summary, avoid large tables. Reply in the user's language.";
    // opts.modelHint: 현재 모델을 주입 → 답변 끝에 상위 모델 권유 제안(판단은 Claude 본인)
    const modelHint = opts.modelHint
      ? `Current model: ${model || "claude (default)"}. Model tiers (low→high): haiku → sonnet → opus → fable. If this question seems to require more capability than the current model, append one short line at the very end of your reply: 💡 \`/model sonnet\` (or \`/model opus\`, \`/model fable\`) for a stronger answer. Omit the suggestion for simple questions.`
      : null;
    // opts.injectMemory: 퍼시스턴트 메모리를 시스템 프롬프트에 주입 (/new 로 초기화해도 유지)
    const mem = opts.injectMemory ? loadMemory() : "";
    // 메모리는 persona보다 앞에 배치하고 헤더를 강화 → persona가 덮어쓰는 것 방지
    const memoryBlock = mem ? `## RULES (must follow before anything else)\n${mem}` : null;
    const handoff = opts.injectHandoff !== false ? loadCodexHandoff() : "";
    const handoffBlock = handoff
      ? `## CODEX FALLBACK HANDOFF\nClaude and Codex sessions are separate. The notes below summarize work Codex handled while Claude was unavailable; use them as context, not as your own prior messages.\n${handoff}`
      : null;
    const imageHint = IMAGE_SEND ? imageSendInstruction() : null;
    const appendSys = [memoryBlock, handoffBlock, cfg.persona, brevity, modelHint, imageHint].filter(Boolean).join("\n\n");
    if (appendSys) args.push("--append-system-prompt", appendSys);
    if (model) args.push("--model", model);
    if (sessionId) args.push("--resume", sessionId);
    // -p와 프롬프트는 맨 끝에 — 터미널 테스트에서 검증된 순서
    // `--` 구분자로 `-`로 시작하는 프롬프트도 옵션으로 오해 안 함
    args.push("-p", "--", prompt);

    const child = spawn(cfg.claudeBin || "claude", args, {
      cwd: cfg.projectDir,
      env: { ...process.env, ...(cfg.env || {}) },
    });
    if (opts.trackChild) opts.trackChild.child = child; // /stop 에서 kill 가능하도록 방 런타임에 노출

    let out = "",
      err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => {
      if (opts.trackChild) opts.trackChild.child = null;
      resolve({ ok: false, text: `Failed to start claude: ${e.message}` });
    });
    child.on("close", (code) => {
      if (opts.trackChild) opts.trackChild.child = null;
      try {
        const j = JSON.parse(out);
        const rawErr = j.result ?? "";
        const text = j.is_error ? classifyClaudeError(rawErr, code) : (rawErr || "(empty response)");
        const resetAt = j.is_error ? parseResetTime(rawErr) : null;
        const canFallback = j.is_error && isFallbackError(rawErr, code);
        const ctxTokens = ctxTokensOf(j.usage, j.num_turns);
        resolve({ ok: !j.is_error, text, sessionId: j.session_id, cost: j.total_cost_usd, ctxTokens, resetAt, canFallback });
      } catch {
        const raw = (err || out || "no output").slice(0, 3500);
        resolve({ ok: false, text: classifyClaudeError(raw, code), resetAt: parseResetTime(raw), canFallback: isFallbackError(raw, code) });
      }
    });
  });
}

function extractCodexTextFromJsonl(out) {
  let sessionId;
  let text = "";
  for (const line of String(out || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      // Current Codex CLI JSONL format.
      if (j.type === "thread.started" && j.thread_id) sessionId = j.thread_id;
      if (j.type === "item.completed" && j.item?.type === "agent_message" && j.item.text) {
        text = j.item.text;
      }
      // Older app-server event format, kept for compatibility.
      if (j.type === "session_meta" && j.payload?.id) sessionId = j.payload.id;
      const p = j.payload;
      if (p?.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
        const parts = p.content
          .filter((c) => c.type === "output_text" && c.text)
          .map((c) => c.text);
        if (parts.length) text = parts.join("\n");
      }
    } catch {}
  }
  return { sessionId, text: text.trim() };
}

function resolveCodexBin() {
  if (cfg.codexBin) return cfg.codexBin;
  const candidates = [
    join(dirname(process.execPath), "codex"),
    join(process.env.HOME || "", ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  return candidates.find((p) => p && existsSync(p)) || "codex";
}

// ── Codex 폴백 실행 ──────────────────────────────────────────────────────
// Claude와 Codex 세션은 호환되지 않는다. Codex는 별도 session id를 방별 codexSessionId에
// 저장하고(호출부가 opts.sessionId로 넘김), Claude 복귀 시 codex-handoff.md 요약을 시스템 프롬프트로 넘겨 맥락을 연결한다.
function runCodex(prompt, lang = "en", opts = {}) {
  return new Promise((resolve) => {
    const header = opts.noHeader ? "" : (lang === "ko" ? "🤖 Codex 폴백\n\n" : "🤖 Codex fallback\n\n");
    const lastPath = join(BOT_DIR, `codex-last-message-${process.pid}.txt`);
    const model = state.codexModel || cfg.codexModel;
    const timeoutMs = cfg.codexTimeout || 600_000;
    const args = ["exec"];
    const resumeSessionId = opts.sessionId; // 세션은 방별로 관리 — 호출부가 명시적으로 넘긴다
    let codexPrompt = prompt;
    if (!resumeSessionId && opts.injectMemory) {
      const context = [loadMemory(), cfg.persona, cfg.appendSystemPrompt, IMAGE_SEND ? imageSendInstruction() : null].filter(Boolean).join("\n\n");
      if (context) codexPrompt = `Project instructions and persistent context:\n${context}\n\nUser request:\n${prompt}`;
    }

    if (resumeSessionId) {
      args.push("resume", "--json", "-o", lastPath);
      if (model) args.push("--model", model);
      args.push(resumeSessionId, "-");
    } else {
      args.push("--json", "-o", lastPath, "-C", cfg.projectDir, "--sandbox", cfg.codexSandbox || "workspace-write");
      if (model) args.push("--model", model);
      args.push("-");
    }

    const child = spawn(resolveCodexBin(), args, {
      cwd: cfg.projectDir,
      env: { ...process.env, ...(cfg.env || {}) },
    });
    if (opts.trackChild) opts.trackChild.child = child;

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.trackChild) opts.trackChild.child = null;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ ok: false, text: `Codex timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.stdin.on("error", () => {});
    child.on("error", (e) => finish({ ok: false, text: `Failed to start codex: ${e.message}` }));
    child.on("close", (code) => {
      const parsed = extractCodexTextFromJsonl(out);
      let finalText = parsed.text;
      if (!finalText) {
        try { finalText = readFileSync(lastPath, "utf8").trim(); } catch {}
      }
      const sessionId = parsed.sessionId || resumeSessionId;
      if (code === 0 && finalText) {
        if (opts.recordHandoff !== false) appendCodexHandoff({ prompt, response: finalText, sessionId });
        return finish({ ok: true, text: header + finalText, sessionId });
      }
      const raw = (err || out || finalText || "no output").slice(0, 1000);
      finish({ ok: false, text: `Codex failed (exit ${code}):\n${raw}`, canFallback: isFallbackError(raw, code) });
    });
    child.stdin.end(codexPrompt);
  });
}

function runPrimary(prompt, opts = {}) {
  if (currentProvider() === "codex") {
    return runCodex(prompt, opts.lang || BOT_LANG, {
      noHeader: true,
      trackChild: opts.trackChild,
      injectMemory: opts.injectMemory,
      recordHandoff: opts.recordHandoff,
      ...(Object.prototype.hasOwnProperty.call(opts, "sessionId") ? { sessionId: opts.sessionId } : {}),
    });
  }
  return runClaude(prompt, opts.sessionId, opts);
}

// launchd 데몬은 로그인 셸(zsh)을 거치지 않아 .zshrc/brew shellenv의 PATH를 상속받지 못한다
// (claudeBin과 동일한 이유). ollamaBin 미지정 시 흔한 설치 경로를 순서대로 탐색한다.
function resolveOllamaBin() {
  if (cfg.ollamaBin) return cfg.ollamaBin;
  const candidates = ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "/usr/bin/ollama"];
  return candidates.find(existsSync) || "ollama";
}

function getCliVersion(bin, kind) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], {
      cwd: cfg.projectDir,
      env: { ...process.env, ...(cfg.env || {}) },
    });
    let output = "", settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    child.on("error", () => finish("unavailable"));
    child.on("close", () => {
      const patterns = {
        claude: /([0-9]+\.[0-9]+\.[0-9]+)/,
        codex: /codex(?:-cli)?\s+v?([0-9]+\.[0-9]+\.[0-9]+)/i,
        ollama: /(?:client\s+version\s+is|ollama\s+version\s+is)\s+v?([0-9]+\.[0-9]+\.[0-9]+)/i,
      };
      finish(output.match(patterns[kind])?.[1] || "unknown");
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish("unavailable");
    }, 3000);
  });
}

async function getCliVersions() {
  const [claude, codex, ollama] = await Promise.all([
    getCliVersion(cfg.claudeBin || "claude", "claude"),
    getCliVersion(resolveCodexBin(), "codex"),
    getCliVersion(resolveOllamaBin(), "ollama"),
  ]);
  return { claude, codex, ollama };
}

// ── Ollama 폴백 실행 ──────────────────────────────────────────────────────
// `ollama launch claude` 로 Claude Code CLI를 로컬 모델로 구동한다. opts.sessionId가
// 있으면 `--resume`으로 기존 대화 맥락을 그대로 이어받는다(HTTP api/chat 방식과 달리 세션 유지).
// 터미널 검증: ollama launch claude --model <m> --yes -- -p -- <prompt> --resume <id>
function runOllama(prompt, lang = "en", opts = {}) {
  return new Promise((resolve) => {
    const header = opts.noHeader ? "" : (lang === "ko"
      ? "🌙 Claude가 잠시 쉬고 있어요. 그동안 저(로컬 모델)는 복귀하면 Claude에게 넘길 내용을 정리하는 걸 도와드릴게요 — 코딩·파일 작업은 Claude가 돌아온 뒤에요.\n\n"
      : "🌙 Claude is resting right now. Meanwhile I (a local model) can help you jot down and organize what to hand off once it's back — coding and file work waits for Claude.\n\n");
    const model = cfg.ollamaModel || "qwen3.5:4b";
    const brevity = "This reply is delivered over Telegram. Be concise — short paragraphs and lists, no filler intro/summary. Reply in the user's language.";
    // 폴백 경로에서만: Claude가 막혀 소형 로컬 모델로 대응 중임을 알리고, 코딩·도구 작업을 시도하는
    // 대신 사용자가 Claude 복귀 후 이어갈 수 있도록 요청 정리·요약을 돕는 조수 역할을 지시한다.
    const fallbackRole = opts.fallback
      ? "You are a small local model standing in because Claude is temporarily unavailable (rate-limited or out of credits). Do NOT attempt coding, file edits, or tool use — you can't do those reliably. Instead, act as a note-taker: help the user capture, organize, and draft what they'll ask Claude to do once it's back. Summaries, request drafts, and tidy notes are your job."
      : "";
    const appendSys = [cfg.persona, brevity, fallbackRole].filter(Boolean).join("\n\n");
    // `--` 앞은 ollama launch 플래그, 뒤는 claude 플래그로 전달된다.
    const claudeArgs = ["--output-format", "json"];
    if (appendSys) claudeArgs.push("--append-system-prompt", appendSys);
    if (opts.sessionId) claudeArgs.push("--resume", opts.sessionId);
    claudeArgs.push("-p", "--", prompt);
    const args = ["launch", "claude", "--model", model, "--yes", "--", ...claudeArgs];

    const child = spawn(resolveOllamaBin(), args, {
      cwd: cfg.projectDir,
      env: { ...process.env, ...(cfg.env || {}) },
    });
    // 로컬 4B 모델 콜드스타트는 첫 응답까지 수 분이 걸릴 수 있어 기본 타임아웃을 넉넉히 잡는다.
    const timer = setTimeout(() => child.kill("SIGKILL"), cfg.ollamaTimeout || 360_000);
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, text: `Failed to start ollama: ${e.message}` }); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        const text = (j.result ?? "").trim();
        if (j.is_error || !text) return resolve({ ok: false, text: text || "no response" });
        resolve({ ok: true, text: header + text, sessionId: j.session_id });
      } catch {
        // JSON 파싱 실패 시 원시 출력으로 폴백 (구버전 ollama·비-JSON 출력 대비)
        const text = (out || "").trim();
        if (text) return resolve({ ok: true, text: header + text });
        resolve({ ok: false, text: (err || "no output").slice(0, 500) });
      }
    });
  });
}

// ── 크론 스케줄러 ─────────────────────────────────────────────────────────
// 표준 cron 5필드 "분 시 일 월 요일"을 의존성 0 유지를 위해 최소 파서로 직접 구현.
// 지원: * · 목록(1,3,5) · 범위(1-5) · 스텝(*/15, 9-17/2). 요일 0·7 = 일요일.
function parseField(field, min, max) {
  const set = new Set();
  for (const part of String(field).split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : parseInt(stepStr, 10);
    let lo, hi;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      [lo, hi] = range.split("-").map((n) => parseInt(n, 10));
    } else {
      lo = hi = parseInt(range, 10);
    }
    if ([lo, hi, step].some(Number.isNaN) || step < 1 || lo < min || hi > max) return null;
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = parseField(f[0], 0, 59);
  const hour = parseField(f[1], 0, 23);
  const dom = parseField(f[2], 1, 31);
  const month = parseField(f[3], 1, 12);
  const dow = parseField(f[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) dow.add(0); // 7=일요일 정규화
  return { minute, hour, dom, month, dow, domStar: f[2] === "*", dowStar: f[4] === "*" };
}

function cronMatches(c, d) {
  if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1))
    return false;
  // 표준 cron 규칙: 일·요일이 둘 다 지정되면 OR, 한쪽이 * 면 AND.
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk;
}

// 예약 작업 = config.schedule(정적) + state.cron(동적, /cron add 로 추가). 잘못된 항목은 버림.
// 각 항목: { cron, prompt, label?, source: "config"|"dynamic", id?(동적만) }.
function buildSchedule() {
  const tag = (arr, source) =>
    (Array.isArray(arr) ? arr : []).map((j) => ({ ...j, parsed: parseCron(j.cron), source }));
  return [...tag(cfg.schedule, "config"), ...tag(state.cron, "dynamic")].filter((j) => {
    if (!j.parsed) return void console.error(`Ignoring invalid cron: ${j.cron}`);
    if (!j.prompt) return void console.error(`Ignoring scheduled job without prompt: ${j.cron}`);
    return true;
  });
}
let schedule = buildSchedule();

// 예약 작업은 사용자 대화 맥락을 오염시키지 않도록 항상 새 세션으로 독립 실행하고,
// 결과를 allowedChatId 로 보낸다. 전용 CRON_KEY 슬롯을 써 예약끼리는 직렬화하되 사용자 방과는 병렬로 돈다.
async function runScheduled(job) {
  const r = rt(CRON_KEY); // 예약 작업끼리는 직렬화하되 사용자 방과는 병렬로 돈다
  if (r.busy || checkLocalLock()) {
    console.warn(`Skipped scheduled job (busy): ${job.cron} — ${String(job.prompt).slice(0, 40)}`);
    return;
  }
  r.busy = true;
  const started = Date.now();
  try {
    const res = await runPrimary(job.prompt, { sessionId: null, lang: BOT_LANG, recordHandoff: false }); // 새 세션 (state 미저장)
    // 조용한 예약 작업: 출력이 비었거나 정확히 "SKIP"이면 전송하지 않는다.
    // (예: "조건 충족 시에만 알리고, 아니면 SKIP만 출력해" 식의 조건부 알림용)
    if (res.ok) {
      const body = (res.text || "").trim();
      if (!body || /^skip$/i.test(body)) {
        console.log(`Scheduled job suppressed (empty/SKIP): ${job.label || job.cron}`);
        return;
      }
    }
    const secs = Math.round((Date.now() - started) / 1000);
    const label = job.label || job.cron;
    const footer = res.ok
      ? `\n\n— ⏰ ${label} · ${secs}s${res.cost ? ` · $${res.cost.toFixed(4)}` : ""}`
      : `\n\n— ⏰ ${label}`;
    for (const id of allowedIds) await send(id, (res.ok ? res.text : `⚠️ ${res.text}`) + footer);
  } catch (e) {
    for (const id of allowedIds) await send(id, t(BOT_LANG, "scheduledError", e.message));
  } finally {
    r.busy = false;
  }
}

function startScheduler() {
  // allowedChatId 없으면 결과를 보낼 곳이 없으니 비활성화. /cron add 로 나중에 작업이
  // 늘 수 있으므로, schedule 이 지금 비어 있어도 인터벌은 항상 돌린다(없으면 no-op).
  if (!allowedIds.length) {
    console.warn("allowedChatId missing → scheduler disabled");
    return;
  }
  console.log(`Scheduled jobs active (${schedule.length}):`, schedule.map((j) => j.cron).join(", "));
  // 30초마다 깨어나되 분 단위로 1회만 실행 → 드리프트에도 같은 분 중복 발사 방지.
  let lastMinute = -1;
  setInterval(() => {
    const now = new Date();
    const minuteKey = Math.floor(now.getTime() / 60000);
    if (minuteKey === lastMinute) return;
    lastMinute = minuteKey;
    for (const job of schedule) if (cronMatches(job.parsed, now)) runScheduled(job);
  }, 30000);
}

// ── /cron 동적 관리 (/cron add·rm·list) ───────────────────────────────────
// /cron add 는 자유 텍스트를 Claude 로 보내 cron 표현식 + 작업 프롬프트를 추출한다.
// 일정 해석을 LLM 에 맡기므로 "every morning at 9", "30분마다" 같은 자연어를 그대로 받는다.
async function extractCron(input, l) {
  const now = new Date();
  const langName = l === "ko" ? "Korean" : "English";
  const ask =
    "From the 'request' below, extract a recurring schedule. Produce a standard 5-field cron " +
    "expression (minute hour day-of-month month day-of-week), the actual task prompt with the " +
    `time expression removed, a short label, and a human-readable schedule description — write ` +
    `the label and description in ${langName}.\n` +
    `Current local time: ${now.toString()}\n` +
    "Reply with ONLY one line of JSON, no prose or code block: " +
    '{"cron":"0 9 * * *","prompt":"the task","label":"short name","human":"every day at 09:00"}\n\n' +
    `request: ${input}`;
  const res = await runPrimary(ask, { sessionId: null, lang: l, recordHandoff: false }); // 새 세션 (대화 맥락과 분리)
  const m = res.text && res.text.match(/\{[\s\S]*\}/);
  if (!res.ok || !m) return { error: res.text || t(l, "extractFail") };
  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return { error: t(l, "extractNoUnderstand") };
  }
  if (!parseCron(obj.cron)) return { error: t(l, "extractBadCron", obj.cron) };
  if (!obj.prompt) return { error: t(l, "extractNoPrompt") };
  return obj;
}

function cronListText(l) {
  const cfgJobs = Array.isArray(cfg.schedule) ? cfg.schedule : [];
  const dynJobs = Array.isArray(state.cron) ? state.cron : [];
  if (!cfgJobs.length && !dynJobs.length) return t(l, "cronEmpty");
  // cron 의 * 가 마크다운 이탤릭으로 깨지지 않도록 목록 전체를 코드블록(<pre>)으로 감쌈.
  const rows = [];
  for (const j of cfgJobs) rows.push(`[config] ${j.cron}  ${j.label || ""} — ${j.prompt}`);
  for (const j of dynJobs) rows.push(`#${j.id} ${j.cron}  ${j.label || ""} — ${j.prompt}`);
  return t(l, "cronListHeader") + "\n```\n" + rows.join("\n") + "\n```\n" + t(l, "cronListFooter");
}

// /autocompact — 인자 없으면 현재값 + 프리셋 버튼, 있으면 설정. 버튼 콜백(ac:*)도 같은 경로를 탄다.
const AUTOCOMPACT_PRESETS = ["50k", "100k", "150k", "200k"];
// 범위 밖 값은 거절한다. 너무 크면(예: 오타로 100m) 압축이 영구히 안 걸리고,
// 너무 작으면 매 턴 압축이 돌아 대화가 못 진행된다 — 둘 다 조용히 망가지는 쪽이라 막는다.
const AUTOCOMPACT_MIN = 10000;
const AUTOCOMPACT_MAX = 1000000;
async function handleAutoCompact(chatId, arg, l) {
  const def = cfg.autoCompactThreshold ?? 100000;
  if (!arg) {
    const cur = state.autoCompactThreshold ?? def;
    const btn = (p) => ({ text: p, callback_data: `ac:${p}` });
    await send(chatId, t(l, "autoCompactStatus", cur, def), {
      replyMarkup: {
        inline_keyboard: [
          AUTOCOMPACT_PRESETS.map(btn),
          [
            { text: t(l, "autoCompactOffBtn"), callback_data: "ac:off" },
            { text: t(l, "autoCompactDefBtn"), callback_data: "ac:default" },
          ],
        ],
      },
    });
    return;
  }
  // 임계값을 새로 정하는 경로에서는 "나중에"로 미뤄둔 기준도 같이 초기화한다.
  if (arg === "default" || arg === "reset") {
    state.autoCompactThreshold = undefined;
    state.autoCompactSnooze = undefined;
    saveState(state);
    await send(chatId, t(l, "autoCompactReset", def));
    return;
  }
  if (arg === "off") {
    state.autoCompactThreshold = 0;
    state.autoCompactSnooze = undefined;
    saveState(state);
    await send(chatId, t(l, "autoCompactOff"));
    return;
  }
  const n = parseTokens(arg);
  if (!Number.isFinite(n) || n < 0) {
    await send(chatId, t(l, "autoCompactUsage"));
    return;
  }
  if (n < AUTOCOMPACT_MIN || n > AUTOCOMPACT_MAX) {
    await send(chatId, t(l, "autoCompactRange", n, AUTOCOMPACT_MIN, AUTOCOMPACT_MAX));
    return;
  }
  state.autoCompactThreshold = n;
  state.autoCompactSnooze = undefined;
  saveState(state);
  await send(chatId, t(l, "autoCompactSet", n));
}

// 임계값 초과 시 압축할지 묻는다 — 버튼 콜백은 `cp:*`.
async function askAutoCompact(chatId, ctxTokens, l) {
  await send(chatId, t(l, "autoCompactAsk", roundTokens(ctxTokens)), {
    replyMarkup: {
      inline_keyboard: [[
        { text: t(l, "autoCompactNowBtn"), callback_data: "cp:yes" },
        { text: t(l, "autoCompactLaterBtn"), callback_data: `cp:later:${ctxTokens}` },
        { text: t(l, "autoCompactOffBtn"), callback_data: "ac:off" },
      ]],
    },
  });
}

// "나중에"를 누르면 지금보다 이만큼 더 커지기 전까지 다시 묻지 않는다.
// 그냥 한 번 넘기기만 하면 다음 턴에 또 물어서 결국 같은 성가심이 된다.
const AUTOCOMPACT_SNOOZE_RATIO = 1.25;
// fmtTokens 는 1000 으로 안 나눠지면 원본 숫자를 그대로 찍는다. 컨텍스트 추정치는 132453 처럼
// 어중간한 값이라 그대로 보여주면 정밀해 보이지만 어차피 추정치다 — k 단위로 반올림해서 보여준다.
const roundTokens = (n) => Math.max(Math.round(n / 1000), 1) * 1000;

// 실제 압축 — 락은 호출자가 잡는다. 자동 압축 트리거는 이미 handle() 안(busy=true)이라
// 여기를 직접 부르고, 버튼·명령은 아래 runCompact() 를 거친다.
async function doCompact(chatId, l, okKey) {
  try {
    const cr = await runClaude("/compact", getSid(chatId, "claude"));
    if (cr.sessionId) setSid(chatId, cr.sessionId, "claude");
    // 압축해도 임계값 아래로 안 내려갈 수 있다. 그때 snooze 를 지워버리면 바로 다음 턴에 또 물어서
    // 무한 반복이 되므로, 압축 직후 컨텍스트를 기준으로 다시 걸어둔다.
    state.autoCompactSnooze = cr.ctxTokens ? roundTokens(cr.ctxTokens * AUTOCOMPACT_SNOOZE_RATIO) : undefined;
    saveState(state);
    if (cr.ok !== false) await send(chatId, t(l, okKey));
    else await send(chatId, t(l, "compactFail", cr.text));
  } catch (e) {
    await send(chatId, t(l, "compactFail", e.message));
  }
}

// 버튼(`cp:yes`)과 /compact 에서 부르는 압축 — busy 락·타이핑 표시를 handle() 과 같은 패턴으로 처리.
// 락 없이 돌리면 압축이 도는 2분 사이에 들어온 메시지가 같은 세션에 동시 투입돼 답이 통째로 사라진다.
async function runCompact(chatId, l, okKey) {
  if (currentProvider() !== "claude") { await send(chatId, t(l, "compactProviderUnsupported")); return; }
  if (!getSid(chatId, "claude")) { await send(chatId, t(l, "compactNoSession")); return; }
  const r = rt(chatId);
  if (r.busy) {
    r.queue.push({ msg: { chat: { id: chatId }, text: "/compact" }, receivedAt: Date.now() });
    await send(chatId, t(l, "queued", r.queue.length));
    return;
  }
  if (checkLocalLock()) {
    await send(chatId, t(l, "localBusy"), { replyMarkup: localKillMarkup(l) });
    return;
  }
  r.busy = true;
  r.typing = setInterval(
    () => tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}),
    5000,
  );
  try {
    // 압축은 오래 걸린다 — 즉시 응답이 없으면 버튼이 안 먹은 것처럼 보인다.
    await send(chatId, t(l, "compacting"));
    await doCompact(chatId, l, okKey);
  } finally {
    clearInterval(r.typing);
    r.typing = null;
    r.busy = false;
    if (r.queue.length > 0 && !rateLimitUntil) setImmediate(() => handle(drainQueue(chatId)));
  }
}

// provider 확인·전환 — /provider 와 버튼(`pv:*`)이 모두 여기로 온다.
// 인자 없이 부르면 현재 provider 를 보여주고 전환 버튼을 함께 보낸다 — 휴대폰에서 `/provider codex`를
// 타이핑하는 대신 한 번 누르면 끝나도록.
const PROVIDERS = ["claude", "codex"];
async function handleProvider(chatId, arg, l) {
  if (rt(chatId).busy) {
    await send(chatId, t(l, "busy"));
    return;
  }
  if (!arg) {
    const cur = currentProvider();
    await send(chatId, t(l, "providerStatus", cur, DEFAULT_PROVIDER), {
      replyMarkup: {
        inline_keyboard: [[
          ...PROVIDERS.map((p) => ({ text: p === cur ? `✅ ${p}` : p, callback_data: `pv:${p}` })),
          { text: t(l, "providerDefBtn"), callback_data: "pv:default" },
        ]],
      },
    });
    return;
  }
  const previousProvider = currentProvider();
  if (arg === "default" || arg === "reset") {
    state.provider = undefined;
    saveState(state);
    await send(chatId, t(l, "providerReset", DEFAULT_PROVIDER));
    resumeQueueAfterProviderSwitch(previousProvider);
    return;
  }
  if (!PROVIDERS.includes(arg)) {
    await send(chatId, t(l, "providerUsage"));
    return;
  }
  state.provider = arg;
  state.ollamaMode = false;
  saveState(state);
  await send(chatId, t(l, "providerSet", arg));
  resumeQueueAfterProviderSwitch(previousProvider);
}

// 모델 확인·전환 — /model 과 버튼(`md:*`)이 모두 여기로 온다.
// Claude 는 별칭 버튼을 주고, Codex 는 전체 모델 ID 를 타이핑해야 해서 기본값 버튼만 준다.
// 버튼에 표시 시점의 provider 를 실어 보낸다 — 누르기 전에 /provider 로 바꿔도 엉뚱한 쪽에 저장되지 않게.
async function handleModel(chatId, arg, l, provider = currentProvider()) {
  const modelStateKey = provider === "codex" ? "codexModel" : "model";
  const configuredModel = provider === "codex" ? cfg.codexModel : cfg.model;
  if (!arg) {
    const cur = state[modelStateKey] || configuredModel || (l === "ko" ? "(기본값)" : "(default)");
    const btn = (text, v) => ({ text, callback_data: `md:${provider}:${v}` });
    const defRow = [btn(t(l, "modelDefBtn"), "default")];
    await send(
      chatId,
      provider === "codex" ? t(l, "codexModelStatus", cur) : t(l, "claudeModelStatus", cur),
      {
        replyMarkup: {
          inline_keyboard: provider === "codex"
            ? [defRow]
            : [CLAUDE_MODEL_SUGGESTIONS.map((m) => btn(m === cur ? `✅ ${m}` : m, m)), defRow],
        },
      },
    );
    return;
  }
  if (arg === "default" || arg === "reset") {
    state[modelStateKey] = undefined;
    saveState(state);
    await send(chatId, t(l, "modelReset", provider, configuredModel || (l === "ko" ? "기본값" : "default")));
    return;
  }
  state[modelStateKey] = arg;
  saveState(state);
  await send(chatId, t(l, "modelSet", provider, arg));
}

// 로컬 세션 상태·종료 — /local, /stop(봇 작업이 없을 때), localBusy 버튼이 모두 여기로 온다.
// 종료는 항상 버튼(또는 `/local kill`)으로 한 번 더 확인받는다 — 데스크탑 작업을 끊는 일이라.
const localKillMarkup = (l) => ({
  inline_keyboard: [[{ text: t(l, "localKillBtn"), callback_data: "local:kill" }]],
});
async function handleLocal(chatId, arg, l) {
  if (arg === "kill" || arg === "stop") {
    const res = await killLocalSession();
    await send(
      chatId,
      res.none ? t(l, "localNone") : res.ok ? t(l, "localKilled", res.pid) : t(l, "localKillFail", res.pid),
    );
    return;
  }
  const info = localLockInfo();
  if (!info) {
    await send(chatId, t(l, "localNone"));
    return;
  }
  await send(chatId, t(l, "localActive", info.pid, info.mins), { replyMarkup: localKillMarkup(l) });
}

async function handleCron(chatId, rest, l) {
  if (rest === "" || rest === "list") {
    await send(chatId, cronListText(l));
    return;
  }
  if (rest === "add" || rest.startsWith("add ")) {
    const input = rest.slice(3).trim();
    if (!input) {
      await send(chatId, t(l, "cronAddUsage"));
      return;
    }
    const rtc = rt(chatId);
    if (rtc.busy) {
      await send(chatId, t(l, "busy"));
      return;
    }
    rtc.busy = true;
    try {
      await tg("sendChatAction", { chat_id: chatId, action: "typing" });
      const r = await extractCron(input, l);
      if (r.error) {
        await send(chatId, `⚠️ ${r.error}`);
        return;
      }
      const list = Array.isArray(state.cron) ? state.cron : [];
      const id = list.reduce((mx, j) => Math.max(mx, j.id || 0), 0) + 1;
      list.push({ id, cron: r.cron, prompt: r.prompt, label: r.label });
      state.cron = list;
      saveState(state);
      schedule = buildSchedule();
      await send(chatId, t(l, "cronAddDone", id, r.human, r.prompt, r.cron));
    } catch (e) {
      await send(chatId, t(l, "botError", e.message));
    } finally {
      rtc.busy = false;
    }
    return;
  }
  if (rest.startsWith("rm ") || rest.startsWith("remove ") || rest.startsWith("del ")) {
    const id = parseInt(rest.replace(/^\w+\s+/, ""), 10);
    const list = Array.isArray(state.cron) ? state.cron : [];
    const idx = list.findIndex((j) => j.id === id);
    if (Number.isNaN(id) || idx < 0) {
      await send(chatId, t(l, "cronRmNotFound"));
      return;
    }
    const [removed] = list.splice(idx, 1);
    state.cron = list;
    saveState(state);
    schedule = buildSchedule();
    await send(chatId, t(l, "cronRmDone", id, removed.prompt));
    return;
  }
  await send(chatId, t(l, "cronUsage"));
}

// ── 첨부 파일 ─────────────────────────────────────────────────────────────
function pickAttachment(msg) {
  if (msg.photo?.length) return { fileId: msg.photo[msg.photo.length - 1].file_id, name: null };
  if (msg.document) return { fileId: msg.document.file_id, name: msg.document.file_name || null };
  if (msg.voice) return { fileId: msg.voice.file_id, name: null };
  if (msg.audio) return { fileId: msg.audio.file_id, name: msg.audio.file_name || null };
  if (msg.video) return { fileId: msg.video.file_id, name: msg.video.file_name || null };
  return null;
}

async function downloadAttachment(att) {
  const info = await tg("getFile", { file_id: att.fileId });
  if (!info.ok) throw new Error("getFile failed");
  const filePath = info.result.file_path; // e.g. photos/file_3.jpg
  const r = await fetch(`https://api.telegram.org/file/bot${cfg.token}/${filePath}`);
  if (!r.ok) throw new Error(`download failed ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const dir = ATTACH_DIR;
  mkdirSync(dir, { recursive: true });
  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")) : "";
  const name = att.name || `tg-${Date.now()}-${att.fileId.slice(-6)}${ext}`;
  const dest = join(dir, name);
  writeFileSync(dest, buf);
  return { dest, name };
}

// ── 텔레그램 메시지 메타데이터 추출 ──────────────────────────────────────
// 그룹 채팅에서 누가 보냈는지 표시할 때 쓰는 이름 포맷 (buildMsgMeta / drainQueue 공용)
function formatSender(u) {
  if (!u) return null;
  if (u.first_name) return `${u.first_name}${u.username ? ` (@${u.username})` : ""}`;
  return u.username ? `@${u.username}` : null;
}
const isGroupChat = (chat) => chat?.type === "group" || chat?.type === "supergroup";

function buildMsgMeta(msg) {
  const parts = [];

  // 그룹 채팅은 발신자가 여러 명일 수 있으니 표시 (1:1은 한 명뿐이라 생략, 큐 병합 메시지는 줄마다 이미 표기)
  if (isGroupChat(msg.chat) && !msg._merged) {
    const sender = formatSender(msg.from);
    if (sender) parts.push(`[From: ${sender}]`);
  }

  // 포워드 출처 (신규 API: forward_origin, 구버전 폴백: forward_from / forward_from_chat)
  const fo = msg.forward_origin;
  if (fo) {
    if (fo.type === "user" && fo.sender_user)
      parts.push(`[Forwarded from: ${fo.sender_user.first_name}${fo.sender_user.username ? ` (@${fo.sender_user.username})` : ""}]`);
    else if (fo.type === "channel" && fo.chat)
      parts.push(`[Forwarded from channel: ${fo.chat.title}${fo.chat.username ? ` (@${fo.chat.username})` : ""}]`);
    else if (fo.type === "chat" && fo.sender_chat)
      parts.push(`[Forwarded from: ${fo.sender_chat.title}]`);
    else if (fo.type === "hidden_user" && fo.sender_user_name)
      parts.push(`[Forwarded from: ${fo.sender_user_name} (hidden)]`);
    else
      parts.push(`[Forwarded message]`);
  } else if (msg.forward_from) {
    const u = msg.forward_from;
    parts.push(`[Forwarded from: ${u.first_name}${u.username ? ` (@${u.username})` : ""}]`);
  } else if (msg.forward_from_chat) {
    const c = msg.forward_from_chat;
    parts.push(`[Forwarded from: ${c.title}${c.username ? ` (@${c.username})` : ""}]`);
  }

  // 리플라이 컨텍스트
  const reply = msg.reply_to_message;
  if (reply) {
    const replyText = (reply.text || reply.caption || "").trim().slice(0, 300);
    const replyFrom = reply.from?.first_name || "unknown";
    parts.push(replyText
      ? `[Replying to ${replyFrom}: "${replyText}${replyText.length >= 300 ? "…" : ""}"]`
      : `[Replying to ${replyFrom}'s message]`);
  }

  return parts.join("\n");
}

// ── 메시지 처리 ───────────────────────────────────────────────────────────
// 방(chat)별 실행 상태 — 방마다 세션이 독립이라 서로 다른 방은 동시에 실행한다.
// busy·child·typing·prevSession·stopping·queue 를 방 단위로 들고, 한 방 안에서는 여전히 직렬화된다
// (단일 머신이라도 CLI 프로세스는 방마다 하나씩 병렬 실행). 레이트리밋만 계정 단위라 전역.
const chatRuntime = new Map(); // chatId → { busy, child, typing, prevSession, stopping, queue }
function rt(chatId) {
  const id = String(chatId);
  let r = chatRuntime.get(id);
  if (!r) {
    r = { busy: false, child: null, typing: null, prevSession: null, stopping: false, queue: [] };
    chatRuntime.set(id, r);
  }
  return r;
}
const CRON_KEY = "__cron__"; // 예약 작업 전용 실행 슬롯 (실제 chatId 와 겹치지 않음)
const mediaGroups = new Map(); // media_group_id → { msgs, timer } — 미디어 그룹 수집 대기
const pendingPlans = new Map(); // chatId → { sessionId, messageId } — /plan 승인 대기
const PLAN_PROCEED_PROMPT = "Proceed with the plan you just approved above. Implement it now.";
let rateLimitUntil = null;  // 레이트 리밋 활성 시 리셋 Date — 이 시간까지 메시지를 큐에 쌓음
let rateLimitTimer = null;  // 리셋 시간에 큐를 드레인하는 타이머

// 모든 방의 대기열을 각자 드레인 (레이트리밋 해제·provider 전환 시). 방마다 독립 실행됨.
function drainAllQueues() {
  for (const [id, r] of chatRuntime) if (r.queue.length > 0) setImmediate(() => handle(drainQueue(id)));
}
// /restart 는 프로세스를 통째로 내리므로 방별 격리와 무관하게 다른 방의 작업·대기열까지 같이 죽는다.
// 요청한 방은 restartOk 로 이미 알고 있으니 빼고, 실제로 잃을 게 있는 방(실행 중이거나 큐가 쌓인 방)에만
// 알린다 — 재시작은 배포 경로라 잦아서, 놀고 있는 방까지 부르면 그냥 소음이 된다.
async function notifyRestartInterrupted(requesterId) {
  const me = String(requesterId);
  for (const [id, r] of chatRuntime) {
    if (id === me || id === CRON_KEY) continue;
    if (!r.busy && !r.queue.length) continue;
    await send(id, t(BOT_LANG, "restartInterrupted", r.queue.length)).catch(() => {});
  }
}
function totalQueued() {
  let n = 0;
  for (const r of chatRuntime.values()) n += r.queue.length;
  return n;
}

// 한도에 걸린 provider에서 다른 provider로 전환하면 예약을 기다릴 이유가 없다.
// 기존 실패 메시지를 포함한 대기열을 새 provider로 즉시 이어서 처리한다.
function resumeQueueAfterProviderSwitch(previousProvider) {
  if (previousProvider === currentProvider() || (!rateLimitUntil && !rateLimitTimer)) return;
  if (rateLimitTimer) clearTimeout(rateLimitTimer);
  rateLimitTimer = null;
  rateLimitUntil = null;
  drainAllQueues();
}

// runClaude 결과를 답장으로 변환 — 폴백/큐잉/자동 컴팩션 처리. handle()과 /plan 승인 실행이 공유.
async function replyWithClaudeResult(chatId, l, prompt, msg, res, started) {
  const r = rt(chatId);
  const secs = Math.round((Date.now() - started) / 1000);
  if (!res.ok) {
    // Codex 폴백: 레이트리밋·크레딧 에러이고 codexFallback 켜져 있으면 reserve 전에 Codex로 재시도
    if (currentProvider() === "claude" && cfg.codexFallback && res.canFallback && !r.stopping) {
      try {
        const cRes = await runCodex(prompt, l, { trackChild: r, sessionId: getSid(chatId, "codex") });
        if (cRes.ok) {
          if (cRes.sessionId) { setSid(chatId, cRes.sessionId, "codex"); saveState(state); }
          await deliver(chatId, cRes.text); return;
        }
        console.error(cRes.text);
      } catch (e) {
        console.error("Codex fallback failed:", e.message);
      }
    }
    // Ollama 폴백: Codex 미사용/실패 시, 레이트리밋·크레딧 에러이고 ollamaFallback 켜져 있으면 Ollama로 재시도
    if (cfg.ollamaFallback && res.canFallback && !r.stopping) {
      try {
        const oRes = await runOllama(prompt, l, {
          fallback: true,
          sessionId: currentProvider() === "claude" ? getSid(chatId, "claude") : undefined,
        });
        if (oRes.ok) {
          if (oRes.sessionId) { setSid(chatId, oRes.sessionId, "claude"); saveState(state); }
          await send(chatId, oRes.text); return;
        }
      } catch {}
    }
    // 리셋 시간을 알면 현재 메시지를 큐 앞에 다시 넣고 타이머 설정
    let autoRetryMsg = "";
    if (res.resetAt && !r.stopping) {
      r.queue.unshift({ msg, receivedAt: Date.now() });
      rateLimitUntil = res.resetAt;
      if (rateLimitTimer) clearTimeout(rateLimitTimer);
      rateLimitTimer = setTimeout(() => {
        rateLimitTimer = null;
        rateLimitUntil = null;
        drainAllQueues();
      }, Math.max(res.resetAt - Date.now(), 1000));
      const timeStr = res.resetAt.toLocaleTimeString(l === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
      autoRetryMsg = "\n\n" + t(l, "reserveAuto", timeStr);
    }
    const errMsg = res.text === "contextTooLong" ? t(l, "contextTooLong") : `⚠️ ${res.text}${autoRetryMsg}`;
    if (!r.stopping) await send(chatId, errMsg);
  } else {
    const footer = `\n\n— ${secs}s${res.cost ? ` · $${res.cost.toFixed(4)}` : ""}`;
    if (!r.stopping) await deliver(chatId, res.text + footer);
    // 자동 컴팩션: 컨텍스트가 임계값을 넘으면 압축할지 물어본다. 예고 없이 압축이 돌면 대화
    // 맥락이 갑자기 요약본으로 바뀌어 흐름이 끊기므로, 기본은 확인을 받는 쪽이다.
    // config 의 autoCompactConfirm:false 로 예전처럼 묻지 않고 바로 압축하게 할 수 있다.
    const compactThreshold = state.autoCompactThreshold ?? cfg.autoCompactThreshold ?? 100000;
    if (currentProvider() === "claude" && compactThreshold > 0 && res.ctxTokens > compactThreshold && getSid(chatId, "claude") && !r.stopping) {
      if (cfg.autoCompactConfirm === false) await doCompact(chatId, l, "autoCompact");
      else if (res.ctxTokens > (state.autoCompactSnooze || 0)) await askAutoCompact(chatId, res.ctxTokens, l);
    }
  }
}

// /plan 승인 후 실행 — busy 락·타이핑 표시를 handle()과 동일한 패턴으로 자체 처리.
async function runApprovedPlan(chatId, l) {
  const pending = pendingPlans.get(chatId);
  pendingPlans.delete(chatId);
  // /new 등으로 세션이 바뀌었으면 이 계획은 더 이상 유효하지 않음
  if (!pending || pending.sessionId !== getSid(chatId, "claude")) {
    await send(chatId, t(l, "planNoPending"));
    return;
  }
  const r = rt(chatId);
  if (r.busy) {
    r.queue.push({ msg: { chat: { id: chatId }, text: PLAN_PROCEED_PROMPT }, receivedAt: Date.now() });
    await send(chatId, t(l, "queued", r.queue.length));
    return;
  }
  if (checkLocalLock()) {
    await send(chatId, t(l, "localBusy"), { replyMarkup: localKillMarkup(l) });
    return;
  }
  r.busy = true;
  const started = Date.now();
  r.typing = setInterval(
    () => tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}),
    5000,
  );
  const syntheticMsg = { chat: { id: chatId }, text: PLAN_PROCEED_PROMPT };
  try {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    r.prevSession = { chatId: String(chatId), provider: "claude", sessionId: getSid(chatId, "claude") };
    const res = await runClaude(PLAN_PROCEED_PROMPT, pending.sessionId, { modelHint: true, trackChild: r, injectMemory: true });
    if (res.sessionId) {
      setSid(chatId, res.sessionId, "claude");
      saveState(state);
    }
    await replyWithClaudeResult(chatId, l, PLAN_PROCEED_PROMPT, syntheticMsg, res, started);
  } catch (e) {
    if (!r.stopping) await send(chatId, t(l, "botError", e.message));
  } finally {
    clearInterval(r.typing);
    r.typing = null;
    r.stopping = false;
    r.busy = false;
    if (r.queue.length > 0 && !rateLimitUntil) setImmediate(() => handle(drainQueue(chatId)));
  }
}

// 처리한 인라인 키보드를 기억한다 — 버튼 제거(editMessageReplyMarkup)는 텔레그램 왕복이라
// 그 사이에 다른 버튼을 또 누를 수 있다. 압축처럼 오래 걸리는 동작에서 실제로 "압축했습니다"와
// "나중에 묻겠습니다"가 같이 뜨는 일이 있었다. 한 키보드당 한 번만 처리한다.
const handledKeyboards = new Set();
const HANDLED_KEYBOARD_MEMORY = 200;

// 텔레그램 인라인 버튼(✅/❌) 클릭 처리
async function handleCallback(cq) {
  const chatId = cq.message?.chat?.id;
  if (!chatId || !allowedIds.includes(String(chatId))) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
    return;
  }
  const kbKey = `${chatId}:${cq.message.message_id}`;
  if (handledKeyboards.has(kbKey)) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
    return;
  }
  handledKeyboards.add(kbKey);
  if (handledKeyboards.size > HANDLED_KEYBOARD_MEMORY)
    handledKeyboards.delete(handledKeyboards.values().next().value);
  const l = langOf({ from: cq.from });
  await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
  // 중복 클릭 방지 — 원본 메시지의 버튼 제거
  tg("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: cq.message.message_id,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
  if (cq.data === "plan:yes") {
    runApprovedPlan(chatId, l).catch((e) => console.error("Plan approval error:", e.message));
  } else if (cq.data === "plan:no") {
    pendingPlans.delete(chatId);
    await send(chatId, t(l, "planCancelled"));
  } else if (cq.data?.startsWith("ac:")) {
    await handleAutoCompact(chatId, cq.data.slice(3), l);
  } else if (cq.data === "cp:yes") {
    await runCompact(chatId, l, "autoCompact");
  } else if (cq.data?.startsWith("cp:later:")) {
    const n = Number(cq.data.slice(9)) || 0;
    state.autoCompactSnooze = roundTokens(n * AUTOCOMPACT_SNOOZE_RATIO);
    saveState(state);
    await send(chatId, t(l, "autoCompactLater", state.autoCompactSnooze));
  } else if (cq.data?.startsWith("pv:")) {
    await handleProvider(chatId, cq.data.slice(3), l);
  } else if (cq.data?.startsWith("md:")) {
    const sep = cq.data.indexOf(":", 3);
    await handleModel(chatId, cq.data.slice(sep + 1), l, cq.data.slice(3, sep));
  } else if (cq.data === "local:kill") {
    await handleLocal(chatId, "kill", l);
  }
}

async function handle(msg) {
  const chatId = msg.chat?.id;
  if (!chatId) return;
  const l = langOf(msg);
  const text = stripBotMention((msg.text || msg.caption || "").trim());
  const attachment = msg._mediaGroup ? null : pickAttachment(msg);
  if (!text && !attachment && !msg._mediaGroup?.length) return;

  // 화이트리스트
  if (!allowedIds.length) {
    await send(chatId, t(l, "needChatId", chatId));
    return;
  }
  if (!allowedIds.includes(String(chatId))) {
    console.warn(`Ignoring unauthorized chatId ${chatId}`);
    return;
  }
  // 혼잣말 — `//` 로 시작하는 메시지는 봇이 무시한다. 작업 중 떠오른 딴 주제 메모를
  // 세션에 넣지 않고 채팅에 남겨두는 용도. 👀 리액션으로 "봤고, 무시했다"만 알린다.
  if (text.startsWith("//")) {
    tg("setMessageReaction", {
      chat_id: chatId,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "👀" }],
    }).catch(() => {});
    return;
  }
  const r = rt(chatId); // 이 방의 실행 상태 (busy·child·typing·queue…)

  // 레이트리밋 활성 중: 일반 메시지는 큐에 추가, 명령어는 통과
  if (rateLimitUntil && Date.now() < rateLimitUntil && !text.startsWith("/")) {
    r.queue.push({ msg, receivedAt: Date.now() });
    const timeStr = rateLimitUntil.toLocaleTimeString(l === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
    await send(chatId, t(l, "rateLimitQueued", r.queue.length, timeStr));
    return;
  }

  // 명령어
  if (text === "/start" || text === "/help") {
    await send(chatId, t(l, "help"));
    return;
  }
  if (text === "/id") {
    await send(chatId, `chatId: ${chatId}`);
    return;
  }
  if (text === "/status") {
    const [latest, cliVersions] = await Promise.all([fetchLatestVersion(), getCliVersions()]);
    const versionStr = !latest || !isNewer(latest, VERSION)
      ? VERSION
      : `${VERSION} → ${latest} ✨`;
    await send(
      chatId,
      t(l, "status", {
        version: versionStr,
        provider: currentProvider(),
        cliVersions,
        name: cfg.name || "claude-telegram-bot",
        model: (currentProvider() === "codex" ? state.codexModel || cfg.codexModel : state.model || cfg.model)
          || (l === "ko" ? "(기본값)" : "(default)"),
        fallback: currentProvider() === "codex"
          ? (cfg.ollamaFallback ? "Ollama" : (l === "ko" ? "꺼짐" : "off"))
          : cfg.codexFallback
            ? `Codex${getSid(chatId, "codex") ? (l === "ko" ? " (세션 있음)" : " (session active)") : ""}`
            : cfg.ollamaFallback
              ? "Ollama"
              : (l === "ko" ? "꺼짐" : "off"),
        hasSession: Boolean(getSid(chatId)),
        jobs: schedule.length,
        projectDir: cfg.projectDir,
        permissionMode: cfg.permissionMode || "acceptEdits",
      }),
    );
    return;
  }
  if (text === "/provider" || text.startsWith("/provider ")) {
    await handleProvider(chatId, text.slice(9).trim().toLowerCase(), l);
    return;
  }
  if (text === "/model" || text.startsWith("/model ")) {
    await handleModel(chatId, text.slice(6).trim(), l);
    return;
  }
  if (text === "/autocompact" || text.startsWith("/autocompact ")) {
    await handleAutoCompact(chatId, text.slice(13).trim(), l);
    return;
  }
  if (text === "/cron" || text.startsWith("/cron ")) {
    await handleCron(chatId, text.slice(5).trim(), l);
    return;
  }
  if (text === "/restart") {
    // 재시작 전 자기 자신(bot.mjs) 문법을 검사 → 깨졌으면 재시작 취소(크래시 루프 방지).
    // 종료만 하고, 다시 띄우는 건 프로세스 관리자(launchd KeepAlive 등)의 몫.
    await send(chatId, t(l, "restartChecking"));
    const check = spawn(process.execPath, ["--check", SELF]);
    let cerr = "";
    check.stderr.on("data", (d) => (cerr += d));
    check.on("close", async (code) => {
      if (code !== 0) {
        await send(chatId, t(l, "restartSyntaxFail", (cerr || "no output").slice(0, 3000)));
        return;
      }
      state.restartNotify = chatId; // 재시작 후 시작 시 완료 알림
      saveState(state);
      await send(chatId, t(l, "restartOk"));
      await notifyRestartInterrupted(chatId);
      process.exit(0);
    });
    return;
  }
  if (text === "/compact") {
    await runCompact(chatId, l, "compactOk");
    return;
  }
  if (text === "/ollama") {
    if (!cfg.ollamaFallback) { await send(chatId, t(l, "ollamaDisabled")); return; }
    state.ollamaMode = !state.ollamaMode;
    saveState(state);
    await send(chatId, t(l, state.ollamaMode ? "ollamaOn" : "ollamaOff"));
    return;
  }
  if (text === "/testfallback") {
    if (!cfg.codexFallback && !cfg.ollamaFallback) { await send(chatId, t(l, "testFallbackDisabled")); return; }
    await send(chatId, cfg.codexFallback ? "🧪 Codex fallback 연결 테스트 중…" : "🧪 Ollama fallback 연결 테스트 중…");
    try {
      const prompt = cfg.codexFallback
        ? "Reply with exactly one sentence: Codex fallback is working."
        : "Reply with exactly one sentence: Ollama fallback is working.";
      const res = cfg.codexFallback
        ? await runCodex(prompt, l, { trackChild: r, recordHandoff: false, sessionId: getSid(chatId, "codex") })
        : await runOllama(prompt, l);
      if (res.ok) {
        if (cfg.codexFallback && res.sessionId) { setSid(chatId, res.sessionId, "codex"); saveState(state); }
        await send(chatId, res.text);
      }
      else await send(chatId, t(l, "testFallbackFail", res.text));
    } catch (e) {
      await send(chatId, t(l, "testFallbackFail", e.message));
    }
    return;
  }
  if (text === "/new") {
    setSid(chatId, undefined); // 이 방의 현재 provider 세션만 초기화 (다른 방·다른 provider는 유지)
    state.autoCompactSnooze = undefined; // 컨텍스트가 비었으니 미뤄둔 것도 의미 없음
    saveState(state);
    await send(chatId, t(l, "newSession"));
    return;
  }
  if (text === "/local" || text.startsWith("/local ")) {
    await handleLocal(chatId, text.slice(6).trim().toLowerCase(), l);
    return;
  }
  if (text === "/stop" || text.startsWith("/stop ")) {
    if (!r.busy || !r.child) {
      // 봇 작업은 없어도 로컬 ctb 가 물고 있을 수 있다 — 종료 버튼을 같이 준다.
      const info = localLockInfo();
      if (info) {
        await send(chatId, t(l, "localActive", info.pid, info.mins), { replyMarkup: localKillMarkup(l) });
        return;
      }
      await send(chatId, t(l, "stopNoop"));
      return;
    }
    const reset = text.includes("--reset");
    r.stopping = true;
    r.queue.length = 0; // 이 방의 대기 메시지도 취소 (다른 방은 그대로)
    r.child.kill();
    if (reset && r.prevSession) {
      setSid(r.prevSession.chatId, r.prevSession.sessionId, r.prevSession.provider);
      saveState(state);
    }
    await send(chatId, t(l, reset ? "stopReset" : "stopOk"));
    return;
  }
  if (text.startsWith("/remember ")) {
    const content = text.slice(10).trim();
    if (!content) { await send(chatId, t(l, "rememberUsage")); return; }
    const existing = loadMemory();
    saveMemory(existing ? `${existing}\n- ${content}` : `- ${content}`);
    await send(chatId, t(l, "remembered"));
    return;
  }
  if (text === "/memory" || text.startsWith("/memory ")) {
    const arg = text.slice(7).trim();
    if (arg === "clear") {
      saveMemory("");
      await send(chatId, t(l, "memoryCleared"));
      return;
    }
    const mem = loadMemory();
    await send(chatId, mem ? t(l, "memoryShow", mem) : t(l, "memoryEmpty"));
    return;
  }
  if (text === "/reserve" || text.startsWith("/reserve ")) {
    const arg = text.slice(8).trim();
    if (arg === "rm") {
      if (!rateLimitUntil && !rateLimitTimer) { await send(chatId, t(l, "reserveNone")); return; }
      if (rateLimitTimer) { clearTimeout(rateLimitTimer); rateLimitTimer = null; }
      rateLimitUntil = null;
      for (const rr of chatRuntime.values()) rr.queue.length = 0; // 모든 방의 예약 대기열 취소
      await send(chatId, t(l, "reserveRm"));
      return;
    }
    if (!rateLimitUntil) { await send(chatId, t(l, "reserveNone")); return; }
    const timeStr = rateLimitUntil.toLocaleTimeString(l === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
    await send(chatId, t(l, "reserveStatus", totalQueued(), timeStr));
    return;
  }

  // 커스텀 명령어 (config.commands) — Claude와 독립 실행
  if (text.startsWith("/")) {
    const cmdName = text.slice(1).split(" ")[0];
    const def = (cfg.commands || {})[cmdName];
    if (def) {
      const run = typeof def === "object" ? def.run : null;
      if (run) {
        const args = text.length > cmdName.length + 1 ? text.slice(cmdName.length + 2) : "";
        const res = await runCustomCommand(run, args || undefined);
        const out = res.text.length > 4000 ? res.text.slice(0, 3990) + "\n…(truncated)" : res.text;
        await send(chatId, `${res.ok ? "" : "⚠️ "}${out}`);
        return;
      }
    }
  }

  if (r.busy) {
    r.queue.push({ msg, receivedAt: Date.now() });
    await send(chatId, t(l, "queued", r.queue.length));
    return;
  }
  if (checkLocalLock()) {
    await send(chatId, t(l, "localBusy"), { replyMarkup: localKillMarkup(l) });
    return;
  }
  r.busy = true;
  const started = Date.now();
  // 긴 작업 동안 타이핑 표시 유지
  r.typing = setInterval(
    () =>
      tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(
        () => {},
      ),
    5000,
  );

  try {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    // /plan <요청> — permission-mode를 강제로 plan으로 실행해 편집 없이 계획만 받고,
    // 승인 버튼을 눌러야 실제 permissionMode로 이어서 실행 (runApprovedPlan).
    if (text === "/plan" || text.startsWith("/plan ")) {
      if (currentProvider() !== "claude") { await send(chatId, t(l, "planProviderUnsupported")); return; }
      const planReq = text.slice(5).trim();
      if (!planReq) { await send(chatId, t(l, "planUsage")); return; }
      r.prevSession = { chatId: String(chatId), provider: "claude", sessionId: getSid(chatId, "claude") };
      const res = await runClaude(planReq, getSid(chatId, "claude"), { permissionMode: "plan", modelHint: true, trackChild: r, injectMemory: true });
      if (res.sessionId) {
        setSid(chatId, res.sessionId, "claude");
        saveState(state);
      }
      if (!res.ok) {
        await send(chatId, `⚠️ ${res.text}`);
        return;
      }
      const messageId = await send(chatId, res.text, {
        replyMarkup: {
          inline_keyboard: [[
            { text: t(l, "planApprove"), callback_data: "plan:yes" },
            { text: t(l, "planCancel"), callback_data: "plan:no" },
          ]],
        },
      });
      pendingPlans.set(chatId, { sessionId: getSid(chatId, "claude"), messageId });
      return;
    }
    let prompt = text;
    if (msg._mediaGroup?.length) {
      const notes = [];
      for (const fileId of msg._mediaGroup) {
        try {
          const { dest, name } = await downloadAttachment({ fileId, name: null });
          notes.push(`[Attachment] Absolute path: ${dest} (filename: ${name}). Open it with the Read tool if needed.`);
        } catch (e) {
          await send(chatId, t(l, "attachFail", e.message));
        }
      }
      if (notes.length) prompt = text ? `${text}\n\n${notes.join("\n")}` : notes.join("\n");
    } else if (attachment) {
      try {
        const { dest, name } = await downloadAttachment(attachment);
        const note = `[Attachment] Absolute path: ${dest} (filename: ${name}). Open it with the Read tool if needed.`;
        prompt = text ? `${text}\n\n${note}` : note;
      } catch (e) {
        await send(chatId, t(l, "attachFail", e.message));
      }
    }
    const meta = buildMsgMeta(msg);
    if (meta) prompt = prompt ? `${meta}\n\n${prompt}` : meta;
    if (state.ollamaMode) {
      try {
        const oRes = await runOllama(prompt, l, { noHeader: true, sessionId: getSid(chatId, "claude") });
        if (oRes.ok) {
          if (oRes.sessionId) { setSid(chatId, oRes.sessionId, "claude"); saveState(state); }
          await send(chatId, oRes.text);
        }
        else await send(chatId, t(l, "testFallbackFail", oRes.text));
      } catch (e) {
        await send(chatId, t(l, "testFallbackFail", e.message));
      }
      return;
    }
    r.prevSession = { chatId: String(chatId), provider: currentProvider(), sessionId: getSid(chatId) }; // /stop --reset 복원 대상 저장
    const res = await runPrimary(prompt, {
      sessionId: getSid(chatId),
      lang: l,
      modelHint: true,
      trackChild: r,
      injectMemory: true,
    });
    if (res.sessionId) {
      setSid(chatId, res.sessionId);
      saveState(state);
    }
    await replyWithClaudeResult(chatId, l, prompt, msg, res, started);
  } catch (e) {
    if (!r.stopping) await send(chatId, t(l, "botError", e.message));
  } finally {
    clearInterval(r.typing);
    r.typing = null;
    r.stopping = false;
    r.busy = false;
    if (r.queue.length > 0 && !rateLimitUntil) setImmediate(() => handle(drainQueue(chatId)));
  }
}

// 한 방(chat)의 대기열 전체를 꺼내 하나로 합침. 여러 개면 번호+경과시간 붙여 병합.
// 큐가 방별로 분리돼 있어 이 안의 메시지는 모두 같은 방·같은 세션 → 안전하게 병합 가능.
function drainQueue(chatId) {
  const group = rt(chatId).queue.splice(0);
  if (group.length === 1) return group[0].msg;
  const groupChat = isGroupChat(group[0].msg.chat);
  const merged = group
    .map((item, i) => {
      const text = item.msg.text || item.msg.caption || "";
      const dt = Math.round((item.receivedAt - group[0].receivedAt) / 1000);
      const label = i === 0 ? "[1]" : `[${i + 1}, +${dt}s]`;
      const sender = groupChat ? formatSender(item.msg.from) : null;
      return sender ? `${label} ${sender}: ${text}` : `${label} ${text}`;
    })
    .join("\n");
  // 마지막 메시지 필드만 남기면 앞서 온 메시지의 사진/첨부가 유실되므로, 전체 첨부를 순서대로 모아 둠
  const fileIds = group.flatMap((item) => {
    if (item.msg._mediaGroup?.length) return item.msg._mediaGroup;
    const att = pickAttachment(item.msg);
    return att ? [att.fileId] : [];
  });
  return {
    ...group[group.length - 1].msg,
    text: merged,
    caption: undefined,
    // 줄마다 발신자를 이미 표기했으니 buildMsgMeta의 단일 [From: ] 태그(마지막 발신자 기준)는 중복이라 생략
    _merged: groupChat || undefined,
    _mediaGroup: fileIds.length ? fileIds : undefined,
  };
}

// 미디어 그룹(여러 장 동시 전송) — 1초 대기 후 일괄 처리
function mergeMediaGroup(msgs) {
  const captions = msgs.map((m) => m.caption || "").filter(Boolean);
  const fileIds = msgs
    .filter((m) => m.photo?.length)
    .map((m) => m.photo[m.photo.length - 1].file_id);
  return { ...msgs[0], text: captions.join("\n"), caption: undefined, _mediaGroup: fileIds };
}

function dispatch(msg) {
  const gid = msg.media_group_id;
  if (!gid) { handle(msg).catch((e) => console.error("Handle error:", e.message)); return; }
  if (!mediaGroups.has(gid)) mediaGroups.set(gid, { msgs: [], timer: null });
  const g = mediaGroups.get(gid);
  g.msgs.push(msg);
  clearTimeout(g.timer);
  g.timer = setTimeout(() => {
    mediaGroups.delete(gid);
    handle(mergeMediaGroup(g.msgs)).catch((e) => console.error("Handle error:", e.message));
  }, 1000);
}

// ── 롱폴링 루프 ───────────────────────────────────────────────────────────
async function main() {
  console.log("Bot started. Polling Telegram...");
  // /restart 로 재시작했으면 완료 알림 1회 (플래그는 즉시 비움)
  if (state.restartNotify) {
    const to = state.restartNotify;
    state.restartNotify = undefined;
    saveState(state);
    await send(to, t(BOT_LANG, "restartDone", schedule.length)).catch(() => {});
  }
  // 그룹에서 오는 `/cmd@BotName` 을 벗겨내려면 내 username 이 필요하다.
  try {
    const me = await tg("getMe");
    if (me.ok && me.result?.username) botUsername = me.result.username;
  } catch {}

  // 텔레그램 명령어 자동완성(/ 입력 시 뜨는 메뉴) 등록. 직접 파싱과 별개로 한 번 알려줘야 함.
  // 기본 목록(BOT_LANG) + 한국어 변형(language_code: ko) → ko 클라이언트는 한국어, 그 외 기본.
  // config.commands 에 정의된 커스텀 명령어도 목록에 추가.
  const customCmdEntries = Object.entries(cfg.commands || {}).map(([name, def]) => ({
    command: name,
    description: (typeof def === "object" ? (def.description || name) : name).slice(0, 256),
  }));
  tg("setMyCommands", { commands: [...(COMMANDS[BOT_LANG] || COMMANDS.en), ...customCmdEntries] }).catch(() => {});
  if (!FORCE_LANG) {
    tg("setMyCommands", { commands: [...COMMANDS.ko, ...customCmdEntries], language_code: "ko" }).catch(() => {});
  }

  // 시작 시 밀린 메시지 건너뛰기
  let offset = 0;
  try {
    const init = await tg("getUpdates", { timeout: 0, offset: -1 });
    if (init.ok && init.result.length)
      offset = init.result[init.result.length - 1].update_id + 1;
  } catch {}

  startScheduler();
  checkForUpdate().catch(() => {});

  while (true) {
    try {
      const res = await tg("getUpdates", { offset, timeout: 30 });
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      for (const upd of res.result) {
        offset = upd.update_id + 1;
        if (upd.message) dispatch(upd.message);
        else if (upd.callback_query) handleCallback(upd.callback_query).catch((e) => console.error("Callback error:", e.message));
      }
    } catch (e) {
      console.error("Polling error:", e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main();
