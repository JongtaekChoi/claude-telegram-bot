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

import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
    console.log(JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version);
    process.exit(0);
  }
  if (a === "init") {
    const target = join(process.argv[3] || process.cwd(), "config.json");
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
// isolated. Falls back to ./config.json for the single-project setup.
const CONFIG_PATH = process.argv[2] || process.env.BOT_CONFIG || join(HERE, "config.json");
const DATA_DIR = dirname(CONFIG_PATH);
// state 파일은 config 이름에서 파생 → 같은 폴더에 여러 페르소나 config 를 둬도 세션이 안 섞임.
// config.json → state.json (단일 봇 호환), 그 외 foo.json → foo.state.json.
const stateBase = basename(CONFIG_PATH, ".json");
const STATE_PATH = join(
  DATA_DIR,
  stateBase === "config" ? "state.json" : `${stateBase}.state.json`,
);

if (!existsSync(CONFIG_PATH)) {
  console.error(
    `Config file not found: ${CONFIG_PATH}\nCopy config.example.json to config.json and fill it in.`,
  );
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
console.log({ ...cfg, token: cfg.token ? "<redacted>" : "(none)" });
const TG = `https://api.telegram.org/bot${cfg.token}`;

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
      "• /new — reset conversation context (new session)\n" +
      "• /cron — list tasks · /cron add <natural language> to add · /cron rm <id> to remove\n" +
      "• /restart — restart the bot (after a syntax check)\n" +
      "• /id — show this chat ID\n" +
      `\nWorking dir: ${cfg.projectDir}\nPermission mode: ${cfg.permissionMode}`,
    newSession: "🆕 Started a new conversation (previous context cleared).",
    busy: "⏳ A previous task is still running. Please try again when it finishes.",
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
    attachFail: (m) => `⚠️ Failed to handle attachment: ${m}`,
    botError: (m) => `Bot error: ${m}`,
    scheduledError: (m) => `⏰ Scheduled task error: ${m}`,
    extractFail: "Extraction failed",
    extractNoUnderstand: "Couldn't understand the schedule. Try rephrasing.",
    extractBadCron: (cron) => `Couldn't parse cron: ${cron}`,
    extractNoPrompt: "Couldn't find what to run.",
  },
  ko: {
    help: () =>
      `${cfg.name || "Claude Code 텔레그램 봇"}\n\n` +
      "• 그냥 메시지를 보내면 Claude가 프로젝트에서 작업합니다.\n" +
      "• /new — 대화 맥락 초기화 (새 세션)\n" +
      "• /cron — 예약 작업 보기 · /cron add <자연어>로 추가 · /cron rm <번호>로 삭제\n" +
      "• /restart — 봇 재시작 (문법 검사 후 안전하게)\n" +
      "• /id — 이 채팅 ID 확인\n" +
      `\n작업 폴더: ${cfg.projectDir}\n권한 모드: ${cfg.permissionMode}`,
    newSession: "🆕 새 대화를 시작합니다 (이전 맥락 초기화).",
    busy: "⏳ 이전 작업이 아직 진행 중입니다. 끝나면 다시 보내주세요.",
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
    attachFail: (m) => `⚠️ 첨부 파일 처리 실패: ${m}`,
    botError: (m) => `봇 오류: ${m}`,
    scheduledError: (m) => `⏰ 예약 작업 오류: ${m}`,
    extractFail: "추출 실패",
    extractNoUnderstand: "일정을 이해하지 못했어요. 다르게 표현해 보세요.",
    extractBadCron: (cron) => `cron 해석 실패: ${cron}`,
    extractNoPrompt: "무엇을 실행할지 찾지 못했어요.",
  },
};
const t = (l, key, ...a) => {
  const v = (STR[l] || STR.en)[key];
  return typeof v === "function" ? v(...a) : v;
};

// /(슬래시) 자동완성 메뉴용 명령 목록 (언어별). setMyCommands 로 등록.
const COMMANDS = {
  en: [
    { command: "new", description: "Reset context (new session)" },
    { command: "cron", description: "List / add / remove scheduled tasks" },
    { command: "restart", description: "Restart the bot (after syntax check)" },
    { command: "id", description: "Show this chat ID" },
    { command: "help", description: "Help" },
  ],
  ko: [
    { command: "new", description: "대화 맥락 초기화 (새 세션)" },
    { command: "cron", description: "예약 작업 보기·추가·삭제" },
    { command: "restart", description: "봇 재시작 (문법 검사 후)" },
    { command: "id", description: "이 채팅 ID 확인" },
    { command: "help", description: "도움말" },
  ],
};

// ── 상태 (세션 이어가기용) ────────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s) {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error("Failed to save state", e);
  }
}
let state = loadState(); // { sessionId?, cron?: [{ id, cron, prompt, label? }], restartNotify? }

// ── 텔레그램 헬퍼 ─────────────────────────────────────────────────────────
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

async function send(chatId, text) {
  for (const c of chunks(text)) {
    const r = await tg("sendMessage", {
      chat_id: chatId,
      text: mdToTelegramHtml(c),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    // If our HTML is malformed for some edge case, resend as plain text.
    if (!r || r.ok === false) {
      await tg("sendMessage", { chat_id: chatId, text: c, disable_web_page_preview: true });
    }
  }
}

// ── Claude 실행 ───────────────────────────────────────────────────────────
function runClaude(prompt, sessionId) {
  return new Promise((resolve) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      cfg.permissionMode || "acceptEdits",
    ];
    const brevity =
      cfg.appendSystemPrompt ??
      "This reply is delivered over Telegram. Be concise — short paragraphs and lists, no filler intro/summary, avoid large tables. Reply in the user's language.";
    // 페르소나(cfg.persona) + 간결 지침을 함께 주입 → 멀티 봇(역할별) 운영용
    const appendSys = [cfg.persona, brevity].filter(Boolean).join("\n\n");
    if (appendSys) args.push("--append-system-prompt", appendSys);
    if (cfg.model) args.push("--model", cfg.model);
    if (sessionId) args.push("--resume", sessionId);

    const child = spawn(cfg.claudeBin || "claude", args, {
      cwd: cfg.projectDir,
      env: { ...process.env, ...(cfg.env || {}) },
    });

    let out = "",
      err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) =>
      resolve({ ok: false, text: `Failed to start claude: ${e.message}` }),
    );
    child.on("close", (code) => {
      try {
        const j = JSON.parse(out);
        resolve({
          ok: !j.is_error,
          text: j.result ?? "(empty response)",
          sessionId: j.session_id,
          cost: j.total_cost_usd,
        });
      } catch {
        resolve({
          ok: false,
          text: `Execution error (exit ${code}):\n${(err || out || "no output").slice(0, 3500)}`,
        });
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
// 결과를 allowedChatId 로 보낸다. busy 락을 공유해 사용자 요청과 직렬화됨.
async function runScheduled(job) {
  if (busy) {
    console.warn(`Skipped scheduled job (busy): ${job.cron} — ${String(job.prompt).slice(0, 40)}`);
    return;
  }
  busy = true;
  const started = Date.now();
  try {
    const res = await runClaude(job.prompt, undefined); // 새 세션 (state 미저장)
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
    await send(cfg.allowedChatId, (res.ok ? res.text : `⚠️ ${res.text}`) + footer);
  } catch (e) {
    await send(cfg.allowedChatId, t(BOT_LANG, "scheduledError", e.message));
  } finally {
    busy = false;
  }
}

function startScheduler() {
  // allowedChatId 없으면 결과를 보낼 곳이 없으니 비활성화. /cron add 로 나중에 작업이
  // 늘 수 있으므로, schedule 이 지금 비어 있어도 인터벌은 항상 돌린다(없으면 no-op).
  if (!cfg.allowedChatId) {
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
  const res = await runClaude(ask, undefined); // 새 세션 (대화 맥락과 분리)
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
    if (busy) {
      await send(chatId, t(l, "busy"));
      return;
    }
    busy = true;
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    try {
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
      busy = false;
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
  const dir = join(DATA_DIR, "attachments");
  mkdirSync(dir, { recursive: true });
  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")) : "";
  const name = att.name || `tg-${att.fileId.slice(-10)}${ext}`;
  const dest = join(dir, name);
  writeFileSync(dest, buf);
  return { dest, name };
}

// ── 메시지 처리 ───────────────────────────────────────────────────────────
let busy = false;

async function handle(msg) {
  const chatId = msg.chat?.id;
  if (!chatId) return;
  const l = langOf(msg);
  const text = (msg.text || msg.caption || "").trim();
  const attachment = pickAttachment(msg);
  if (!text && !attachment) return;

  // 화이트리스트
  if (!cfg.allowedChatId) {
    await send(chatId, t(l, "needChatId", chatId));
    return;
  }
  if (String(chatId) !== String(cfg.allowedChatId)) {
    console.warn(`Ignoring unauthorized chatId ${chatId}`);
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
      process.exit(0);
    });
    return;
  }
  if (text === "/new") {
    state.sessionId = undefined;
    saveState(state);
    await send(chatId, t(l, "newSession"));
    return;
  }

  if (busy) {
    await send(chatId, t(l, "busy"));
    return;
  }
  busy = true;
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  const started = Date.now();
  // 긴 작업 동안 타이핑 표시 유지
  const typing = setInterval(
    () =>
      tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(
        () => {},
      ),
    5000,
  );

  try {
    let prompt = text;
    if (attachment) {
      try {
        const { dest, name } = await downloadAttachment(attachment);
        const note = `[Attachment] Absolute path: ${dest} (filename: ${name}). Open it with the Read tool if needed.`;
        prompt = text ? `${text}\n\n${note}` : note;
      } catch (e) {
        await send(chatId, t(l, "attachFail", e.message));
      }
    }
    const res = await runClaude(prompt, state.sessionId);
    if (res.sessionId) {
      state.sessionId = res.sessionId;
      saveState(state);
    }
    const secs = Math.round((Date.now() - started) / 1000);
    const footer = res.ok
      ? `\n\n— ${secs}s${res.cost ? ` · $${res.cost.toFixed(4)}` : ""}`
      : "";
    await send(chatId, (res.ok ? res.text : `⚠️ ${res.text}`) + footer);
  } catch (e) {
    await send(chatId, t(l, "botError", e.message));
  } finally {
    clearInterval(typing);
    busy = false;
  }
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
  // 텔레그램 명령어 자동완성(/ 입력 시 뜨는 메뉴) 등록. 직접 파싱과 별개로 한 번 알려줘야 함.
  // 기본 목록(BOT_LANG) + 한국어 변형(language_code: ko) → ko 클라이언트는 한국어, 그 외 기본.
  tg("setMyCommands", { commands: COMMANDS[BOT_LANG] || COMMANDS.en }).catch(() => {});
  if (!FORCE_LANG) {
    tg("setMyCommands", { commands: COMMANDS.ko, language_code: "ko" }).catch(() => {});
  }

  // 시작 시 밀린 메시지 건너뛰기
  let offset = 0;
  try {
    const init = await tg("getUpdates", { timeout: 0, offset: -1 });
    if (init.ok && init.result.length)
      offset = init.result[init.result.length - 1].update_id + 1;
  } catch {}

  startScheduler();

  while (true) {
    try {
      const res = await tg("getUpdates", { offset, timeout: 30 });
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      for (const upd of res.result) {
        offset = upd.update_id + 1;
        if (upd.message) await handle(upd.message);
      }
    } catch (e) {
      console.error("Polling error:", e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main();
