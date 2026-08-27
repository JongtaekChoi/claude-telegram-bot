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
// 시스템 프롬프트)와 `permissionMode` 를 다르게 주면 됨. state 와 /remember 메모리는 config
// 이름에서 파생되므로 한 폴더에서 봇을 여럿 띄워도 안 섞임.
//
// 사용자 대상 문구는 영어 기본 + 한국어(STR 테이블). 언어는 텔레그램 from.language_code 로
// 자동 판별하고, cfg.lang 을 주면 그 언어로 고정함. 콘솔/CLI 출력은 영어 단일.

import { basename, dirname, join, resolve, sep } from "node:path";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import dns from "node:dns";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";

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
    // README 의 빠른 시작이 아직 없는 폴더(~/botconfigs/my-project)를 가리킨다 — 없으면 만든다.
    mkdirSync(dirname(target), { recursive: true });
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
// 메모리 파일명도 state 와 같은 규칙으로 config 이름에서 파생시킨다. 지금까지는 BOT_DIR 아래
// memory.md 하나뿐이라, 한 폴더에서 봇을 둘 띄우면(개발자·기획자) **서로의 규칙을 주입받았다.**
// 페르소나가 붙으면 그 뒤에 id 를 더 붙인다 — 한 봇이 여러 역할을 맡아도 안 섞이게.
// config.json → memory.md · memory.dev.md / planner.json → planner.memory.md · planner.memory.dev.md
// 기본 config + 페르소나 없음이면 경로가 예전과 같아서 대다수 사용자는 아무것도 바뀌지 않는다.
// → docs/design/room-personas.md
const memoryBase = stateBase === "config" ? "memory" : `${stateBase}.memory`;
// 페르소나 id 는 그대로 파일명이 되므로 경로가 될 수 있는 글자를 막는다 — `dev/x` 하나면
// .claude-bot/ 밖에 쓴다. 어긋나는 id 는 페르소나 없음으로 떨어뜨린다(config 오타를 부팅 때
// 짚어 주는 건 페르소나 목록이 생기는 1단계 몫이다).
const PERSONA_ID_RE = /^[a-z0-9][a-z0-9-]*$/i;
const memoryPathFor = (personaId) =>
  join(BOT_DIR, personaId && PERSONA_ID_RE.test(personaId) ? `${memoryBase}.${personaId}.md` : `${memoryBase}.md`);
const MEMORY_PATH = memoryPathFor(null); // /new 로 초기화해도 유지되는 퍼시스턴트 메모리
const LEGACY_MEMORY_PATH = join(BOT_DIR, "memory.md"); // 이름 붙은 config 가 예전에 같이 쓰던 파일
const MEMORY_CROWDED = 8; // 이 개수를 넘으면 /remember 응답에 정리 권유를 붙인다 (loadMemory 위 주석 참고)
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
    // 이름 붙은 config 는 지금까지 공유 memory.md 를 읽었다. 경로가 바뀌는 순간 규칙이 통째로
    // 주입에서 빠지므로 한 번 채워 준다. **옮기지 않고 복사한다** — 저 파일에는 여러 봇의 규칙이
    // 섞여 쌓여 있고 어느 줄이 누구 것인지 코드가 가를 수 없다. 양쪽에 같은 내용을 두고 각자
    // /memory rm 으로 지우는 편이 안전하다: 지운 규칙은 다시 쓰면 되지만, 사라진 규칙은 사라진
    // 줄도 모른다. 원본은 그대로 두므로 옛 봇이 아직 돌고 있어도 깨지지 않는다.
    if (MEMORY_PATH !== LEGACY_MEMORY_PATH && !existsSync(MEMORY_PATH) && existsSync(LEGACY_MEMORY_PATH)) {
      copyFileSync(LEGACY_MEMORY_PATH, MEMORY_PATH);
      console.log(`Copied memory → ${MEMORY_PATH} (shared memory.md kept — trim each side with /memory rm)`);
    }
    // personas 를 새로 넣은 봇: 아직 아무 방도 안 골랐어도 기본 페르소나로 돌기 시작하므로
    // 메모리 경로도 같이 옮겨간다. 그대로 두면 지금까지 쌓인 규칙이 조용히 주입에서 빠진다.
    // 위와 같은 이유로 옮기지 않고 복사한다.
    const defaultMemory = PERSONAS.length ? memoryPathFor(PERSONAS[0].id) : null;
    if (defaultMemory && !existsSync(defaultMemory) && existsSync(MEMORY_PATH)) {
      copyFileSync(MEMORY_PATH, defaultMemory);
      console.log(`Copied memory → ${defaultMemory} (default persona "${PERSONAS[0].id}")`);
    }
    if (IMAGE_SEND) mkdirSync(OUTBOX_DIR, { recursive: true }); // 에이전트가 보낼 이미지를 놓는 폴더
    if (JOBS) mkdirSync(JOBS_DIR, { recursive: true }); // 에이전트가 띄운 백그라운드 작업 기록
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
// 백그라운드 작업(.ctb-jobs): 텔레그램용 에이전트는 메시지마다 새 프로세스로 떴다가 답장과 함께
// 죽는다. 에이전트가 띄운 백그라운드도 그때 같이 죽으므로, 오래 살아야 할 작업은 nohup 으로 프로세스
// 그룹 밖에 내보내고 봇은 여기서 **생사만 지켜본다**. 봇이 자식으로 소유하면 /restart 한 번에 전부
// 죽는다 — 배포 수단이 작업 학살 수단이 되면 안 된다. 아웃박스와 같은 파일시스템 인계 방식이다.
const JOBS = cfg.backgroundJobs !== false;
const JOBS_DIR = join(cfg.projectDir || DATA_DIR, ".ctb-jobs");
const JOB_TICK_MS = 30_000;
const JOB_LOG_TAIL = 1200; // 완료 알림에 붙일 로그 꼬리 길이
// 방 사이 전달(/tell): 이 봇이 맡은 다른 방으로 메시지 하나를 넘긴다. 방마다 세션이 독립이라
// 옆방이 알아낸 걸 가져올 통로가 없던 자리다. → docs/design/room-relay.md
const ROOM_RELAY = cfg.roomRelay !== false;
// 방별 페르소나: config 에 역할 목록을 두고 방마다 하나를 가리킨다. 역할을 프로세스가 아니라
// 방으로 가르는 것이라, 봇 하나가 개발방·기획방을 동시에 맡을 수 있다. **목록이 없으면 지금과
// 완전히 같이 동작한다** — 이 레포는 공개 배포물이고 대다수 사용자는 페르소나를 안 쓴다.
// id 는 메모리 파일명과 state 키가 되므로 부팅 때 걸러 내고, 왜 뺐는지 로그에 남긴다.
// → docs/design/room-personas.md
const PERSONAS = (() => {
  const list = cfg.personas;
  if (list === undefined) return [];
  if (!Array.isArray(list)) { console.error("config.personas must be an array — ignoring it"); return []; }
  const out = [], seen = new Set();
  for (const p of list) {
    const id = typeof p?.id === "string" ? p.id.trim() : "";
    if (!PERSONA_ID_RE.test(id)) { console.error(`Persona skipped — id must be [a-z0-9-]: ${JSON.stringify(p?.id)}`); continue; }
    if (seen.has(id)) { console.error(`Persona skipped — duplicate id: ${id}`); continue; }
    if (typeof p.prompt !== "string" || !p.prompt.trim()) { console.error(`Persona skipped — no prompt: ${id}`); continue; }
    seen.add(id);
    out.push({ ...p, id, name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : id });
  }
  return out;
})();
// 사람은 한 생각을 여러 메시지로 쪼개 보낸다 — "아까 그 버그 말인데" / "테스트부터 돌려봐" / "아 로그도".
// 첫 줄에 즉시 반응하면 나머지는 이미 시작된 작업 뒤에 줄을 서고(`⏳ 대기열에 추가됐습니다`), 반쪽짜리
// 맥락으로 돌린 그 실행은 답까지 따로 와서 통째로 버려진다. 그래서 잠깐 기다렸다 합쳐 한 번만 돈다.
// 길이는 /mergewindow 로 재시작 없이 바꾼다 — 손에 맞는 값은 사람마다 다른데(두 줄째를 치는 속도),
// 상수로 박아두면 그걸 찾는 데 매번 재시작이 든다.
// 텔레그램의 타이핑 표시는 보낸 지 5초면 스스로 꺼진다. 딱 5초마다 갱신하면 왕복 지연(수백 ms)만큼
// 매번 늦게 도착해 주기마다 표시가 잠깐씩 끊긴다 — 긴 작업일수록 "돌고는 있나" 싶게 보인다.
// 만료 전에 조금 일찍 덮어써서 끊김 없이 이어지게 한다.
const TYPING_TICK_MS = 4000;
const MERGE_WINDOW_DEFAULT = cfg.mergeWindowMs ?? 1000; // 0 이면 끔 — 예전처럼 즉시 실행
const MERGE_HOLD_RATIO = 5; // 말이 계속 이어져도 첫 메시지 기준 이 배수에서는 끊고 시작한다
const mergeWindowMs = () => state.mergeWindowMs ?? MERGE_WINDOW_DEFAULT;
// 텔레그램 상한(4096자)을 넘는 텍스트를 붙여넣으면 클라이언트가 알아서 조각내 보낸다. 조각에는
// "이어짐" 표시가 없지만 길이로 알아볼 수 있다 — 상한에 바짝 붙어 있고, 관측한 조각은 숫자 중간에서
// 끊겨 있었다(`"yaw":-66.2,"lockLocal":[-0.027,-0.`). 사람이 이 길이에 딱 맞춰 말을 끝내는 일은 없다.
const SPLIT_HINT_LEN = 3900;
// 조각이 보이면 창을 이만큼으로 늘린다. 첫 조각은 클라이언트가 ack 를 받고서야 나머지를 몰아 보내는
// 탓에 유독 멀리 떨어져 도착한다 — 실제로 8조각짜리 로그에서 2번 이후는 서로 +0s 였는데 1번만 1초
// 밖이었다. 기본 1초로는 그 1번만 혼자 반쪽짜리 맥락으로 실행되고 나머지는 대기열로 밀린다.
// 넉넉히 잡은 건 양쪽 대가가 다르기 때문이다 — 오탐(정말 4000자짜리 한 통이었던 경우)은 8초를
// 더 기다리는 게 전부지만, 놓치면 실행 한 번을 통째로 버린다.
const SPLIT_WINDOW_MS = 8000;
// 마지막 조각은 상한에 못 미치므로 여기서 false 가 된다 — 붙여넣기가 끝나면 창은 곧바로 기본값으로
// 돌아와 닫힌다. 늘어난 창이 끝까지 발목을 잡지 않는다.
const looksSplit = (msg) => (msg?.text?.length ?? 0) >= SPLIT_HINT_LEN;
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
      "• /* ignores everything until a message starting with */ — for a run of notes or a pasted log\n" +
      "• /new — reset conversation context (new session)\n" +
      "• /newchat [name] — open a new topic and start fresh there (forum groups) · /newtopic works too\n" +
      "• /sessions — list past sessions in this project and pick one to carry on from\n" +
      "• /name — name the current session so it stands out in /sessions\n" +
      "• /jobs — background jobs that outlive replies · you get a message when one ends\n" +
      "• /persona — the role this room runs as, and the prompt behind it · change it at /new\n" +
      "• /tell <room> <message> — hand a message to another room this bot runs · /tell alone lists them\n" +
      "• /compact — compress context to free up space (keeps the session)\n" +
      "• /plan <request> — plan only (no edits), then approve/cancel to run for real\n" +
      "• /plan on|off — pin plan mode to this room until you turn it off\n" +
      "• Codex fallback can run automatically when Claude hits a limit (if enabled)\n" +
      "• /ollama — toggle Ollama chat mode (bypass Claude, use local LLM)\n" +
      "• /stop — stop the current task · /stop --reset to also roll back the session\n" +
      "• /local — which room a local `ctb` session holds · end it from here\n" +
      "• /cron — list tasks · /cron add <natural language> to add · /cron rm <id> to remove\n" +
      "• /remember <text> — save to persistent memory (survives /new)\n" +
      "• /memory — view memory · /memory rm <n> to drop lines (`3`, `3 5 7`, `3-9`) · /memory clear to wipe\n" +
      "• /reserve — show retry queue status at usage-limit reset · /reserve rm to cancel\n" +
      "• /restart — restart the bot (after a syntax check)\n" +
      "• /status — bot status & version\n" +
      "• /provider — view / switch this room's provider\n" +
      "• /model — view / switch this room's model\n" +
      "• /autocompact — view / set the auto-compact token threshold\n" +
      "• /mergewindow — view / set how long to wait for a follow-up message\n" +
      "• /id — show this chat ID\n" +
      `\nWorking dir: ${cfg.projectDir}\nPermission mode: ${cfg.permissionMode}`,
    chatMigrated: (from, to) =>
      "🔀 This group was upgraded to a supergroup, so Telegram issued it a new chat ID " +
      `(${from} → ${to}). The bot followed the move — sessions came along and everything keeps working.\n` +
      `Update \`allowedChatId\` in config.json to ${to} when you get a chance; the old ID is dead now.`,
    newSession: "🆕 Started a new conversation (previous context cleared).",
    newTopicDefaultName: (stamp) => `New chat ${stamp}`,
    newTopicCreated: (name) => `🆕 Opened a new topic: ${name}\nThe conversation continues there with a fresh session.`,
    newTopicHello: "🆕 New topic, new session. Go ahead.",
    newTopicNotGroup: "/newchat opens a new topic, so it only works in a group. In a DM use /new instead.",
    newTopicFail: (m) =>
      `⚠️ Could not create the topic: ${m}\n` +
      "The group must be a supergroup with Topics turned on, and the bot needs the “Manage topics” permission.",
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
    planUsage:
      "Usage: `/plan <request>` — e.g. `/plan add input validation to the signup form`\n" +
      "`/plan on` · `/plan off` — keep this room in plan mode until you turn it off.",
    planLockStatus: (on) =>
      on
        ? "📐 Plan mode is *pinned* in this room — every message plans first, and nothing is edited until you approve."
        : "📐 Plan mode is off in this room. Messages run normally.",
    planLockOn:
      "📐 Plan mode pinned. Every message in this room now plans first, and I'll ask before touching anything.\n" +
      "`/plan off` to unpin.",
    planLockOff: "📐 Plan mode unpinned. Messages run normally again.",
    planLockOnBtn: "📐 Pin plan mode",
    planLockOffBtn: "Unpin",
    planLockAsk: "Proceed with this plan?",
    planLockCodexWarn:
      "\n\n⚠️ Plan mode stays pinned but does *not* apply to Codex — this room will edit files normally until you switch back to claude.",
    planLockNoFallback:
      "⚠️ Skipped the Codex fallback because plan mode is pinned here — Codex would edit files instead of planning. `/plan off` to allow it.",
    planApprove: "✅ Proceed",
    planCancel: "❌ Cancel",
    planCancelled: "❌ Plan cancelled. No changes were made.",
    planNoPending: "No pending plan to approve (it may have expired after /new). Send /plan again.",
    planExpiredByCompact:
      "📐 The plan that was waiting for approval expired — compacting starts a new session. " +
      "Send it again if you still want it.",
    planProviderUnsupported: "/plan approval flow currently requires provider=claude.",
    tellOff: "Room relay is off (`roomRelay: false` in config).",
    personaOff:
      "🎭 No personas configured. Add a `personas` list to the config file to give each room its own "
      + "role — one bot can then run a dev room and a planning room at once.",
    personaShow: (name, id, body, others) =>
      `🎭 This room runs as **${name}** (\`${id}\`).\n\n${body}\n\n`
      + (others ? `Other roles: ${others}\n` : "")
      + "A role is fixed for the life of a session — send `/new` to pick again.",
    personaPick: (cur) => `🎭 Role for this room — now **${cur}**. Tap to change it:`,
    personaFirst: (cur) =>
      `🎭 New room. It runs as **${cur}** unless you pick another — just carry on if that's right:`,
    personaSet: (name) => `🎭 This room now runs as **${name}**. Its memory and rules are its own.`,
    personaSame: (name) => `🎭 Already **${name}**.`,
    personaLocked: (cur, next) =>
      `🎭 This room is mid-conversation as **${cur}**, so it can't become **${next}** now — everything said `
      + "so far belongs to the current role.\n\nSend `/new` to drop that context, then pick again.",
    personaGone: "🎭 That role is no longer in the config.",
    sessionsPersonaNote: (role) =>
      `🎭 Only **${role}** sessions are listed. ❓ = started before roles existed — picking one files it under ${role}.`,
    sessionPersonaUnknown: (role) =>
      `🎭 That session predates roles, so it's now filed under **${role}** — it will only show up in ${role} rooms from here on.`,
    tellNoRooms:
      "📨 No other room to hand anything to yet. This bot only knows rooms it has already talked in — "
      + "say something there once and it shows up here.",
    tellList: (rooms) =>
      `📨 Rooms this bot knows:\n\n${rooms}\n\n`
      + "`/tell <room> <message>` — room can be the number above or any distinctive part of the name.\n"
      + "It runs in that room with that room's session, and the answer stays there.",
    tellUsage: "Usage: `/tell <room> <message>` — send `/tell` on its own to list the rooms.",
    tellUnknownRoom: (rooms) => `📨 No room matches that. Rooms this bot knows:\n\n${rooms}`,
    tellAmbiguous: (rooms) =>
      `📨 That matches more than one room:\n\n${rooms}\n\nUse the number, or a longer part of the name.`,
    tellSelf: "📨 That's this room. Just say it here.",
    tellMuted: (room) => `📨 ${room} is muted (\`/*\`). Nothing was sent — unmute it there with \`*/\` first.`,
    tellSent: (room) => `📨 Handed to ${room}. The answer stays in that room.`,
    tellIncoming: (room) => `📨 From ${room} — running it here:`,
    tellAsk: (room, body) => `📨 ${room} wants to hand this over:\n\n${body}\n\nRun it here?`,
    tellAskSent: (room) => `📨 Asked ${room} to take this. It runs there once someone approves.`,
    tellApprove: "✅ Run it",
    tellReject: "❌ Ignore",
    tellRejected: "❌ Ignored. Nothing ran.",
    tellExpired: "That hand-off is no longer pending (the bot may have restarted since).",
    tellNoHop: (room) =>
      `📨 Did not pass this on to ${room} — a message that arrived from another room can't be relayed onward. `
      + "That one-hop rule is what keeps two rooms from talking to each other forever.",
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
    localBusy: "💻 A local `ctb` session has this room open. Send a message when it's done, or end it here — other rooms are unaffected.",
    localKillBtn: "💻 End local session",
    localActive: (pid, mins, where) =>
      `💻 A local \`ctb\` session is running${where ? ` on **${where}**` : ""} ` +
      `(PID ${pid}, started ${mins}m ago).${where ? "\nOther rooms keep working." : ""}`,
    localNone: "No local `ctb` session is running.",
    localKilled: (pid) => `🛑 Ended the local \`ctb\` session (PID ${pid}).`,
    localKillFail: (pid) =>
      `⚠️ Couldn't end PID ${pid} — it may need to be closed in the terminal.`,
    needChatId: (id) => `Add this chat ID to "allowedChatId" in config.json:\n${id}`,
    roomNotAllowed: (id, cfgPath, guide) =>
      "👋 I'm in this chat, but it isn't on the allow list — until it is, I ignore everything said here.\n\n" +
      "This chat's ID:\n" +
      `\`${id}\`\n\n` +
      "Add it to `allowedChatId` in the bot's config file, then restart the bot:\n" +
      `\`${cfgPath}\`\n\n` +
      "```json\n" +
      `{ "allowedChatId": ["<existing id>", "${id}"] }\n` +
      "```\n" +
      `Group setup, including the BotFather privacy setting: ${guide}\n\n` +
      "⚠️ Allowing a group hands the bot to **everyone in it** — the allow list is per room, not per person.\n" +
      "*(Said once per chat, so I don't become a spam relay.)*",
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
      (i.persona ? `• Role: ${i.persona}\n` : "") +
      `• Session: ${i.hasSession ? "active" : "none (fresh)"}\n` +
      `• Scheduled jobs: ${i.jobs}\n` +
      `• Project: ${i.projectDir}\n` +
      `• Permission: ${i.permissionMode}`,
    claudeModelStatus: (cur) =>
      `🧠 Claude model: ${cur}\n` +
      "Tap to switch, or send `/model <full-model-id>`",
    codexModelStatus: (cur, models) =>
      `🧠 Codex model: ${cur}\n` +
      (models.length
        ? `Available in this Codex CLI: ${models.join(" · ")}\nTap to switch. Default is the safest choice.`
        : "Set: `/model <full-codex-model-id>`\nDefault is the safest choice; unavailable model IDs can fail."),
    codexModelUnknown: (m, models) =>
      `⚠️ Set to ${m}, but it isn't in this Codex CLI's model list — runs may fail.\n` +
      `Listed: ${models.join(" · ")}\nRevert with /model default.`,
    modelDefBtn: "Default",
    modelSet: (provider, m) => `🧠 This room's ${provider} model is now: ${m}`,
    modelReset: (provider, def) => `🧠 This room's ${provider} model reset to default (${def}).`,
    providerStatus: (cur, def) => `🤖 Provider: ${cur}${cur === def ? " (config default)" : ` (config default: ${def})`}`,
    providerDefBtn: "Config default",
    providerSet: (provider) => `🤖 This room now uses ${provider}. Existing Claude and Codex sessions are preserved separately.`,
    providerReset: (provider) => `🤖 This room returned to the config default (${provider}).`,
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
    mergeWindowStatus: (cur, def) =>
      `⏱ Merge window: ${fmtDuration(cur)}${cur === def ? " (default)" : ""}\n` +
      "Messages sent within this window are merged and answered in one pass.\n" +
      "Tap a button below, or `/mergewindow 2s`",
    mergeWindowSet: (n) => `⏱ Merge window: ${fmtDuration(n)} — messages sent that close together are answered together.`,
    mergeWindowOff: "⏱ Merge window off — every message runs immediately.",
    mergeWindowReset: (def) => `⏱ Merge window reset to default (${fmtDuration(def)}).`,
    mergeWindowUsage: "Usage: `/mergewindow 2s` (or 2000) · `/mergewindow off` · `/mergewindow default`",
    mergeWindowRange: (n, min, max) =>
      `⚠️ ${fmtDuration(n)} is out of range — keep it between ${fmtDuration(min)} and ${fmtDuration(max)}. ` +
      "Use `/mergewindow off` to disable it instead.",
    mergeWindowOffBtn: "Off",
    mergeWindowDefBtn: "Default",
    memoryEmpty: "No memory yet. Use `/remember <text>` to add.",
    memoryShow: (m) => `💾 Memory:\n\`\`\`\n${m}\n\`\`\`\n\`/memory rm <n>\` removes lines — \`3\`, \`3 5 7\`, or \`3-9\`. \`/memory clear\` wipes all.`,
    memoryCleared: "🧹 Memory cleared. The current chat may still follow it — `/new` starts a fresh chat without it.",
    memoryRemoved: (s, n) => `🗑 Removed${n > 1 ? ` ${n} rules` : ""}:\n\`\`\`\n${s}\n\`\`\`\nThe current chat may still follow ${n > 1 ? "them" : "it"} — \`/new\` starts a fresh chat without ${n > 1 ? "them" : "it"}.`,
    remembered: "💾 Saved to memory.",
    memoryCrowded: (n) => `⚠️ ${n} rules in memory. The more there are, the weaker each one pulls — trim with \`/memory\` · \`/memory rm <n>\`.`,
    rememberUsage: "Usage: /remember <text to remember>",
    memoryUsage: (n) => `Usage: /memory · /memory rm <n>${n ? ` (1–${n})` : ""} — also \`3 5 7\` or \`3-9\` · /memory clear wipes all`,
    muteOn: "🙈 Comment mode — everything in this chat is ignored until a message starting with `*/`.",
    muteOff: "🙊 Comment mode off.",
    sessionsHeader: (p, n) =>
      `🗂 ${n} recent ${p} session(s). Pick one to carry on from — ✅ this room's, 🔒 held by another room, 💻 open in a terminal.`,
    sessionsEmpty: (p) => `No past ${p} sessions found for this project.`,
    sessionSwitched: (p, label) => `🗂 Switched to ${p} session \`${label}\`. Your next message continues it.`,
    sessionAlready: (label) => `✅ Already on \`${label}\` — nothing changed.`,
    sessionHeld: "🔒 Another room is on that session. Two rooms on one session overwrite each other's context.",
    sessionInTerminal: "💻 That session is open in a terminal right now. Close it there first — two processes on one session overwrite each other's context.",
    nameUsage: "Usage: `/name Tom` — names this session so you can spot it in /sessions. `/name -` removes the name.",
    nameCurrent: (n) => `🏷 This session is \`${n}\`. \`/name <new>\` to rename, \`/name -\` to remove.`,
    nameSet: (n) => `🏷 This session is now \`${n}\`.`,
    nameCleared: "🏷 Name removed.",
    nameNoSession: "No session to name yet — send a message first, then name it.",
    jobsOff: "Background jobs are off (`backgroundJobs: false` in config).",
    jobsEmpty: "No background jobs. Ask for something long-running and it'll be started detached, so it survives the reply.",
    jobsList: (run, done, body, dir) =>
      `⚙️ Background jobs — ▶ ${run} running, ✅ ${done} finished\n\n${body}\n\nLogs: \`${dir}\``,
    jobDone: (name, cmd, ran, tail) =>
      `✅ Job \`${name}\` finished${ran ? ` after ${ran}` : ""}.${cmd ? `\n\`${cmd}\`` : ""}` +
      (tail ? `\n\nLast output:\n\`\`\`\n${tail}\n\`\`\`` : "\n(no output)"),
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
      "• /* 를 보내면 */ 로 시작하는 메시지가 올 때까지 전부 무시합니다 — 메모를 연달아 남기거나 로그를 붙여넣을 때\n" +
      "• /new — 대화 맥락 초기화 (새 세션)\n" +
      "• /newchat [이름] — 새 주제를 만들어 거기서 새 세션 시작 (주제 켜진 그룹) · /newtopic 도 같음\n" +
      "• /sessions — 이 프로젝트의 지난 세션 목록 · 골라서 이어가기\n" +
      "• /name — 지금 세션에 이름 붙이기 · /sessions 에서 바로 찾기\n" +
      "• /jobs — 답장 후에도 살아 있는 백그라운드 작업 · 끝나면 먼저 알려줌\n" +
      "• /persona — 이 방이 어떤 역할로 도는지와 그 프롬프트 본문 · 바꾸는 건 /new 에서\n" +
      "• /tell <방> <메시지> — 이 봇이 맡은 다른 방으로 메시지 넘기기 · /tell 만 보내면 방 목록\n" +
      "• /compact — 컨텍스트 압축 (세션 유지, 공간 확보)\n" +
      "• /plan <요청> — 계획만 세우기 (편집 없음) → 승인/취소로 실제 실행\n" +
      "• /plan on|off — 끌 때까지 이 방을 plan 모드로 고정\n" +
      "• Codex 폴백 활성화 시 Claude 한도 도달 때 자동으로 대신 실행\n" +
      "• /ollama — Ollama 채팅 모드 토글 (Claude 우회, 로컬 LLM 사용)\n" +
      "• /stop — 진행 중인 작업 중단 · /stop --reset 으로 세션도 되돌리기\n" +
      "• /local — 로컬 `ctb` 세션이 잡고 있는 방 확인 · 여기서 종료\n" +
      "• /cron — 예약 작업 보기 · /cron add <자연어>로 추가 · /cron rm <번호>로 삭제\n" +
      "• /remember <내용> — 퍼시스턴트 메모리에 저장 (/new 로 초기화해도 유지)\n" +
      "• /memory — 메모리 보기 · /memory rm <번호> 로 삭제 (`3`, `3 5 7`, `3-9`) · /memory clear 로 전체 삭제\n" +
      "• /reserve — 한도 리셋 시 대기열 상태 확인 · /reserve rm 으로 취소\n" +
      "• /restart — 봇 재시작 (문법 검사 후 안전하게)\n" +
      "• /status — 봇 상태·버전 보기\n" +
      "• /provider — 이 방의 provider 보기·전환\n" +
      "• /model — 이 방의 모델 보기·전환\n" +
      "• /autocompact — 자동 압축 임계값 보기·설정\n" +
      "• /mergewindow — 다음 메시지를 얼마나 기다렸다 합칠지 보기·설정\n" +
      "• /id — 이 채팅 ID 확인\n" +
      `\n작업 폴더: ${cfg.projectDir}\n권한 모드: ${cfg.permissionMode}`,
    chatMigrated: (from, to) =>
      "🔀 이 그룹이 슈퍼그룹으로 승격되면서 텔레그램이 채팅 ID 를 새로 발급했습니다 " +
      `(${from} → ${to}). 봇이 알아서 따라왔고 세션도 그대로 옮겼습니다.\n` +
      `언제든 config.json 의 \`allowedChatId\` 를 ${to} 로 바꿔두세요 — 옛 ID 는 이제 죽은 값입니다.`,
    newSession: "🆕 새 대화를 시작합니다 (이전 맥락 초기화).",
    newTopicDefaultName: (stamp) => `새 대화 ${stamp}`,
    newTopicCreated: (name) => `🆕 새 주제를 만들었습니다: ${name}\n거기서 새 세션으로 이어집니다.`,
    newTopicHello: "🆕 새 주제, 새 세션입니다. 말씀하세요.",
    newTopicNotGroup: "/newchat 은 새 주제를 만드는 기능이라 그룹에서만 됩니다. DM 에서는 /new 를 쓰세요.",
    newTopicFail: (m) =>
      `⚠️ 주제를 만들지 못했습니다: ${m}\n` +
      "슈퍼그룹에서 '주제(Topics)'가 켜져 있어야 하고, 봇에 '주제 관리' 권한이 있어야 합니다.",
    busy: "⏳ 이전 작업이 아직 진행 중입니다. 끝나면 다시 보내주세요.",
    queued: (n) => `⏳ 대기열에 추가됐습니다 (${n}번째). 현재 작업이 끝나면 자동으로 실행됩니다.`,
    stopOk: "🛑 작업을 중단했습니다.",
    stopReset: "🛑 작업을 중단하고 세션을 작업 이전으로 되돌렸습니다.",
    stopNoop: "실행 중인 작업이 없습니다.",
    localBusy: "💻 이 방을 로컬 `ctb` 세션이 잡고 있습니다. 종료 후 메시지를 보내거나, 여기서 종료하세요 — 다른 방은 그대로 씁니다.",
    localKillBtn: "💻 로컬 세션 종료",
    localActive: (pid, mins, where) =>
      `💻 로컬 \`ctb\` 세션이 ${where ? `**${where}** 방에서 ` : ""}실행 중입니다 ` +
      `(PID ${pid}, ${mins}분 전 시작).${where ? "\n다른 방은 그대로 동작합니다." : ""}`,
    localNone: "실행 중인 로컬 `ctb` 세션이 없습니다.",
    localKilled: (pid) => `🛑 로컬 \`ctb\` 세션을 종료했습니다 (PID ${pid}).`,
    localKillFail: (pid) => `⚠️ PID ${pid} 를 종료하지 못했습니다 — 터미널에서 직접 닫아야 할 수 있습니다.`,
    needChatId: (id) => `이 채팅 ID를 config.json 의 allowedChatId 에 넣으세요:\n${id}`,
    roomNotAllowed: (id, cfgPath, guide) =>
      "👋 이 방에 들어왔지만 아직 허용 목록에 없습니다 — 등록되기 전까지는 여기서 하는 말을 전부 무시합니다.\n\n" +
      "이 방의 채팅 ID 입니다:\n" +
      `\`${id}\`\n\n` +
      "봇 설정 파일의 `allowedChatId` 에 넣고 봇을 재시작하세요:\n" +
      `\`${cfgPath}\`\n\n` +
      "```json\n" +
      `{ "allowedChatId": ["기존 ID", "${id}"] }\n` +
      "```\n" +
      `그룹 설정 방법 (BotFather privacy 설정 포함): ${guide}\n\n` +
      "⚠️ 그룹을 허용하면 **그 방에 있는 모든 사람**에게 봇을 넘기는 것과 같습니다 — 화이트리스트는 사람이 아니라 방 단위입니다.\n" +
      "*(스팸 중계기가 되지 않도록 이 안내는 방마다 한 번만 보냅니다.)*",
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
      (i.persona ? `• 역할: ${i.persona}\n` : "") +
      `• 세션: ${i.hasSession ? "이어가는 중" : "없음 (새 세션)"}\n` +
      `• 예약 작업: ${i.jobs}개\n` +
      `• 작업 폴더: ${i.projectDir}\n` +
      `• 권한 모드: ${i.permissionMode}`,
    claudeModelStatus: (cur) =>
      `🧠 현재 Claude 모델: ${cur}\n` +
      "버튼으로 전환하거나 `/model <전체 모델 ID>`",
    codexModelStatus: (cur, models) =>
      `🧠 현재 Codex 모델: ${cur}\n` +
      (models.length
        ? `현재 Codex CLI에서 선택 가능: ${models.join(" · ")}\n버튼으로 선택하세요. 가장 안전한 선택은 기본값입니다.`
        : "설정: `/model <Codex 전체 모델 ID>`\n가장 안전한 선택은 기본값이며, 지원하지 않는 ID는 실행 중 오류가 날 수 있습니다."),
    codexModelUnknown: (m, models) =>
      `⚠️ ${m}(으)로 설정했지만 현재 Codex CLI의 목록에 없습니다 — 실행 중 오류가 날 수 있습니다.\n` +
      `목록: ${models.join(" · ")}\n되돌리기: /model default`,
    modelDefBtn: "기본값",
    modelSet: (provider, m) => `🧠 이 방의 ${provider} 모델을 ${m}(으)로 설정했습니다.`,
    modelReset: (provider, def) => `🧠 이 방의 ${provider} 모델을 기본값(${def})으로 되돌렸습니다.`,
    providerStatus: (cur, def) => `🤖 현재 provider: ${cur}${cur === def ? " (config 기본값)" : ` (config 기본값: ${def})`}`,
    providerDefBtn: "config 기본값",
    providerSet: (provider) => `🤖 이 방의 provider를 ${provider}(으)로 변경했습니다. Claude와 Codex의 기존 세션은 각각 유지됩니다.`,
    providerReset: (provider) => `🤖 이 방의 provider를 config 기본값(${provider})으로 되돌렸습니다.`,
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
    mergeWindowStatus: (cur, def) =>
      `⏱ 병합 창: ${fmtDuration(cur, "ko")}${cur === def ? " (기본값)" : ""}\n` +
      "이 시간 안에 연달아 보낸 메시지는 하나로 합쳐 한 번에 답합니다.\n" +
      "아래 버튼을 누르거나 `/mergewindow 2s`",
    mergeWindowSet: (n) => `⏱ 병합 창: ${fmtDuration(n, "ko")} — 이 안에 연달아 보내면 합쳐서 답합니다.`,
    mergeWindowOff: "⏱ 병합 창을 껐습니다 — 메시지마다 바로 실행합니다.",
    mergeWindowReset: (def) => `⏱ 병합 창을 기본값으로 되돌렸습니다 (${fmtDuration(def, "ko")}).`,
    mergeWindowUsage: "사용법: `/mergewindow 2s` (또는 2000) · `/mergewindow off` · `/mergewindow default`",
    mergeWindowRange: (n, min, max) =>
      `⚠️ 범위를 벗어난 값입니다 (${fmtDuration(n, "ko")}) — ${fmtDuration(min, "ko")} ~ ${fmtDuration(max, "ko")} 사이로 넣어주세요. ` +
      "끄려면 `/mergewindow off`를 쓰세요.",
    mergeWindowOffBtn: "끄기",
    mergeWindowDefBtn: "기본값",
    memoryEmpty: "저장된 메모리가 없습니다. `/remember <내용>`으로 추가하세요.",
    memoryShow: (m) => `💾 메모리:\n\`\`\`\n${m}\n\`\`\`\n\`/memory rm <번호>\` 로 지웁니다 — \`3\`, \`3 5 7\`, \`3-9\`. 전부 비우려면 \`/memory clear\``,
    memoryCleared: "🧹 메모리를 삭제했습니다. 진행 중인 대화에는 한동안 남습니다 — `/new` 로 대화를 새로 시작하면 사라집니다.",
    memoryRemoved: (s, n) => `🗑 ${n > 1 ? `${n}개 ` : ""}삭제했습니다:\n\`\`\`\n${s}\n\`\`\`\n진행 중인 대화에는 한동안 남습니다 — \`/new\` 로 대화를 새로 시작하면 사라집니다.`,
    remembered: "💾 메모리에 저장했습니다.",
    memoryCrowded: (n) => `⚠️ 메모리 ${n}개. 많아질수록 각 규칙의 구속력이 약해집니다 — \`/memory\` · \`/memory rm <번호>\` 로 정리하세요.`,
    rememberUsage: "사용법: /remember <기억할 내용>",
    memoryUsage: (n) => `사용법: /memory · /memory rm <번호>${n ? ` (1~${n})` : ""} — \`3 5 7\` · \`3-9\` 도 가능 · /memory clear 로 전체 삭제`,
    muteOn: "🙈 주석 모드 — `*/` 로 시작하는 메시지를 보낼 때까지 이 방의 입력을 전부 무시합니다.",
    muteOff: "🙊 주석 모드를 끝냈습니다.",
    sessionsHeader: (p, n) =>
      `🗂 최근 ${p} 세션 ${n}개. 골라서 그 대화를 이어갈 수 있습니다 — ✅ 이 방의 세션, 🔒 다른 방이 쓰는 중, 💻 터미널에서 열려 있음.`,
    sessionsEmpty: (p) => `이 프로젝트의 지난 ${p} 세션을 찾지 못했습니다.`,
    sessionSwitched: (p, label) => `🗂 ${p} 세션 \`${label}\` 으로 바꿨습니다. 다음 메시지부터 그 대화를 이어갑니다.`,
    sessionAlready: (label) => `✅ 이미 \`${label}\` 세션입니다 — 바뀐 것 없습니다.`,
    sessionHeld: "🔒 다른 방이 쓰고 있는 세션입니다. 한 세션에 두 방이 붙으면 서로의 맥락을 덮어씁니다.",
    sessionInTerminal: "💻 지금 터미널에서 열려 있는 세션입니다. 거기서 먼저 닫아주세요 — 한 세션에 두 프로세스가 붙으면 서로의 맥락을 덮어씁니다.",
    nameUsage: "사용법: `/name 톰` — 지금 세션에 이름을 붙여 /sessions 에서 바로 찾게 합니다. 지우려면 `/name -`",
    nameCurrent: (n) => `🏷 이 세션의 이름은 \`${n}\` 입니다. 바꾸려면 \`/name 새이름\`, 지우려면 \`/name -\``,
    nameSet: (n) => `🏷 이 세션의 이름을 \`${n}\` 으로 정했습니다.`,
    nameCleared: "🏷 이름을 지웠습니다.",
    nameNoSession: "아직 이름 붙일 세션이 없습니다 — 메시지를 한 번 보낸 뒤에 붙여주세요.",
    jobsOff: "백그라운드 작업이 꺼져 있습니다 (config 의 `backgroundJobs: false`).",
    jobsEmpty: "돌고 있는 백그라운드 작업이 없습니다. 오래 걸리는 일을 시키면 답장과 무관하게 살아남도록 떼어 내서 띄웁니다.",
    jobsList: (run, done, body, dir) =>
      `⚙️ 백그라운드 작업 — ▶ 실행 중 ${run}개, ✅ 끝난 것 ${done}개\n\n${body}\n\n로그: \`${dir}\``,
    jobDone: (name, cmd, ran, tail) =>
      `✅ 작업 \`${name}\` 이 끝났습니다${ran ? ` (${ran} 걸림)` : ""}.${cmd ? `\n\`${cmd}\`` : ""}` +
      (tail ? `\n\n마지막 출력:\n\`\`\`\n${tail}\n\`\`\`` : "\n(출력 없음)"),
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
    planUsage:
      "사용법: `/plan <요청>` — 예: `/plan 회원가입 폼에 입력값 검증 추가해줘`\n" +
      "`/plan on` · `/plan off` — 끌 때까지 이 방을 plan 모드로 고정합니다.",
    planLockStatus: (on) =>
      on
        ? "📐 이 방은 plan 모드로 *고정*되어 있습니다 — 모든 메시지가 계획부터 세우고, 승인 전에는 아무것도 건드리지 않습니다."
        : "📐 이 방의 plan 고정은 꺼져 있습니다. 메시지가 평소대로 실행됩니다.",
    planLockOn:
      "📐 plan 모드를 고정했습니다. 이제 이 방의 모든 메시지가 계획부터 세우고, 실행 전에 물어봅니다.\n" +
      "해제는 `/plan off`.",
    planLockOff: "📐 plan 고정을 해제했습니다. 메시지가 평소대로 실행됩니다.",
    planLockOnBtn: "📐 plan 고정",
    planLockOffBtn: "해제",
    planLockAsk: "이 계획대로 진행할까요?",
    planLockCodexWarn:
      "\n\n⚠️ plan 고정은 유지되지만 Codex 에는 *적용되지 않습니다* — claude 로 돌아오기 전까지 이 방은 평소대로 파일을 수정합니다.",
    planLockNoFallback:
      "⚠️ plan 고정 중이라 Codex 폴백을 건너뛰었습니다 — Codex 는 계획 대신 파일을 수정합니다. 허용하려면 `/plan off`.",
    planApprove: "✅ 진행",
    planCancel: "❌ 취소",
    planCancelled: "❌ 계획을 취소했습니다. 아무 변경도 없습니다.",
    planNoPending: "승인할 계획이 없습니다 (/new 이후 만료됐을 수 있음). /plan 을 다시 보내세요.",
    planExpiredByCompact:
      "📐 승인 대기 중이던 계획은 만료됐습니다 — 압축하면 세션이 새로 시작됩니다. " +
      "필요하면 다시 보내세요.",
    planProviderUnsupported: "/plan 승인 흐름은 현재 provider=claude에서만 사용할 수 있습니다.",
    tellOff: "방 사이 전달이 꺼져 있습니다 (config 의 `roomRelay: false`).",
    personaOff:
      "🎭 설정된 페르소나가 없습니다. config 에 `personas` 목록을 넣으면 방마다 역할을 줄 수 있습니다 — "
      + "봇 하나가 개발방과 기획방을 동시에 맡습니다.",
    personaShow: (name, id, body, others) =>
      `🎭 이 방은 **${name}** (\`${id}\`) 로 돕니다.\n\n${body}\n\n`
      + (others ? `다른 역할: ${others}\n` : "")
      + "역할은 세션이 사는 동안 고정입니다 — `/new` 를 보내면 다시 고를 수 있습니다.",
    personaPick: (cur) => `🎭 이 방의 역할 — 지금은 **${cur}** 입니다. 눌러서 바꾸세요:`,
    personaFirst: (cur) =>
      `🎭 처음 보는 방이네요. 따로 안 고르면 **${cur}** 로 돕니다 — 맞으면 그냥 이어가세요:`,
    personaSet: (name) => `🎭 이 방은 이제 **${name}** 로 돕니다. 메모리와 규칙도 이 역할 것을 씁니다.`,
    personaSame: (name) => `🎭 이미 **${name}** 입니다.`,
    personaLocked: (cur, next) =>
      `🎭 이 방은 **${cur}** 로 대화가 진행 중이라 지금 **${next}** 로 바꿀 수 없습니다 — 지금까지 오간 `
      + "말이 전부 현재 역할의 것입니다.\n\n`/new` 로 그 맥락을 버린 뒤에 다시 고르세요.",
    personaGone: "🎭 그 역할은 이제 config 에 없습니다.",
    sessionsPersonaNote: (role) =>
      `🎭 **${role}** 세션만 보입니다. ❓ 는 역할이 생기기 전 세션이고, 고르면 ${role} 것으로 기록됩니다.`,
    sessionPersonaUnknown: (role) =>
      `🎭 역할이 생기기 전 세션이라 이제 **${role}** 것으로 기록했습니다 — 앞으로는 ${role} 방에서만 보입니다.`,
    tellNoRooms:
      "📨 넘길 만한 다른 방이 아직 없습니다. 이 봇은 한 번이라도 대화한 방만 압니다 — "
      + "그 방에서 아무 메시지나 한 번 보내면 목록에 뜹니다.",
    tellList: (rooms) =>
      `📨 이 봇이 아는 방:\n\n${rooms}\n\n`
      + "`/tell <방> <메시지>` — 방은 위 번호나 이름의 일부만 적어도 됩니다.\n"
      + "그 방의 세션으로 실행되고, 답도 그 방에 남습니다.",
    tellUsage: "사용법: `/tell <방> <메시지>` — `/tell` 만 보내면 방 목록이 나옵니다.",
    tellUnknownRoom: (rooms) => `📨 해당하는 방이 없습니다. 이 봇이 아는 방:\n\n${rooms}`,
    tellAmbiguous: (rooms) =>
      `📨 여러 방이 걸립니다:\n\n${rooms}\n\n번호를 쓰거나 이름을 더 길게 적어주세요.`,
    tellSelf: "📨 지금 이 방입니다. 여기서 그냥 말하면 됩니다.",
    tellMuted: (room) => `📨 ${room} 은(는) 뮤트 상태입니다 (\`/*\`). 보내지 않았습니다 — 그 방에서 \`*/\` 로 먼저 푸세요.`,
    tellSent: (room) => `📨 ${room} 에 넘겼습니다. 답은 그 방에 남습니다.`,
    tellIncoming: (room) => `📨 ${room} 에서 온 메시지 — 여기서 실행합니다:`,
    tellAsk: (room, body) => `📨 ${room} 에서 이걸 넘기려고 합니다:\n\n${body}\n\n여기서 실행할까요?`,
    tellAskSent: (room) => `📨 ${room} 에 전달을 요청했습니다. 그 방에서 승인하면 실행됩니다.`,
    tellApprove: "✅ 실행",
    tellReject: "❌ 무시",
    tellRejected: "❌ 무시했습니다. 아무것도 실행하지 않았습니다.",
    tellExpired: "그 전달 요청은 더 이상 대기 중이 아닙니다 (그 사이 봇이 재시작됐을 수 있습니다).",
    tellNoHop: (room) =>
      `📨 ${room} 으로는 넘기지 않았습니다 — 다른 방에서 전달받은 메시지는 다시 전달할 수 없습니다. `
      + "이 한 홉 규칙이 두 방이 서로 영원히 대화하는 걸 막습니다.",
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
// 병합 창 길이 표시·해석. 밀리초가 원 단위지만(설정 키가 mergeWindowMs) 사람이 읽고 쓰는 건 "2s" 쪽이라
// 둘 다 받는다. 단위 없는 숫자는 ms — `/mergewindow 2000` 이 2초여야지 2000초면 곤란하다.
function fmtDuration(ms, l = "en") {
  if (!ms) return l === "ko" ? "꺼짐" : "off";
  return ms >= 100 ? `${+(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}
function parseDuration(raw) {
  const m = String(raw).replace(/[,_\s]/g, "").match(/^(\d+(?:\.\d+)?)(ms|s)?$/i);
  if (!m) return NaN;
  return Math.round(Number(m[1]) * (m[2] && m[2].toLowerCase() === "s" ? 1000 : 1));
}
function parseTokens(raw) {
  const m = String(raw).replace(/[,_\s]/g, "").match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!m) return NaN;
  const mult = m[2] ? (m[2].toLowerCase() === "k" ? 1000 : 1000000) : 1;
  return Math.round(Number(m[1]) * mult);
}

// /model 에서 보여줄 추천 별칭(claude CLI 가 별칭·전체 모델 ID 모두 허용).
const CLAUDE_MODEL_SUGGESTIONS = ["fable", "opus", "sonnet", "haiku"];

// Codex CLI가 내려받은 계정별 모델 목록을 그대로 사용한다. 하드코딩하면 모델 출시·폐기와
// 계정별 rollout 차이를 따라갈 수 없다. 캐시가 없거나 형식이 바뀌면 빈 목록으로 폴백한다.
function codexModelSuggestions() {
  try {
    const codexHome = cfg.env?.CODEX_HOME || process.env.CODEX_HOME
      || join(process.env.HOME || "", ".codex");
    const parsed = JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf8"));
    const models = Array.isArray(parsed) ? parsed : parsed.models;
    if (!Array.isArray(models)) return [];
    return models
      .filter((m) => m?.visibility === "list" && typeof m.slug === "string" && m.slug)
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => m.slug);
  } catch {
    return [];
  }
}

// ── 지난 세션 목록 (/sessions) ────────────────────────────────────────────
// Claude·Codex 모두 세션 기록을 jsonl 로 남긴다. 파일명이 곧 세션 ID 라, 목록을 만들어
// 고르게 하고 setSid 로 갈아끼우면 지난 대화를 그대로 이어받을 수 있다(이미 --resume 을 쓰고 있다).
// 기록 파일은 14MB 를 넘기도 하므로 통째로 읽지 않고 앞부분만 잘라 읽는다.
const SESSION_LIST_MAX = 10; // 버튼으로 보여줄 개수
const SESSION_SCAN_MAX = 200; // Codex 는 전 프로젝트가 한 폴더에 섞여 있어 훑는 개수를 막아둔다
const SESSION_HEAD_BYTES = 128 * 1024; // cwd 와 세션 ID 가 들어올 만큼만
const SESSION_TAIL_BYTES = 64 * 1024; // 마지막 사용자 메시지를 찾을 만큼만

function readHead(path, bytes = SESSION_HEAD_BYTES) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, bytes, 0));
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function readTail(path, bytes = SESSION_TAIL_BYTES) {
  let fd;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    fd = openSync(path, "r");
    const buf = Buffer.alloc(Math.min(bytes, size));
    const text = buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, start));
    // 중간부터 읽었으면 첫 줄은 잘려 있다 — JSON 도 깨지고 글자 중간에서 잘린 흔적도 여기 몰리니 버린다.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

// 봇이 사용자 글 앞뒤에 붙이는 메타 줄 — 앞은 `[From: …]`·`[Forwarded …]`·`[Replying to …]`
// (buildMsgMeta), 뒤는 `[Attachment] …`. 전부 따로 줄을 차지하므로 미리보기에선 걷어낸다.
// 안 걷어내면 그룹방 세션은 죄다 같은 줄로 시작해 서로 구별이 안 되고, 아래 PREVIEW_SKIP 의
// `[` 규칙에도 걸려 미리보기가 통째로 빈다. 메타만 있는 메시지는 빈 문자열이 되어 다음 후보로 넘어간다.
// 앞쪽 메타는 `[…]` 로 줄이 끝나지만 첨부는 `[Attachment] 경로…` 처럼 태그 뒤에 본문이 이어져서
// 같은 규칙으로 못 잡는다. 뒤쪽은 태그 이름을 박아 좁게 지운다.
const stripMsgMeta = (text) =>
  text.replace(/^(?:\s*\[[^\n]*\]\s*\n)+/, "").replace(/(?:\n\s*\[Attachment\][^\n]*)+$/, "");

// 미리보기로 쓸 수 없는 턴 — 슬래시 명령 출력(`<…>`), 주의 문구, 그리고 훅이 사람 대신 끼워 넣는
// 지시문. 훅 문구는 설정하기 나름이라 전부는 못 거르지만 흔한 것만 막아도 목록이 훨씬 읽힌다.
// 걸리면 그 다음 후보로 물러선다.
// `<ctb:` 는 ctb 가 세션에 끼워 넣는 턴의 공용 접두사(시작 마커·인수인계 요청). 문구가 바뀌어도
// 접두사는 그대로라 여기를 따라 고칠 필요가 없다(첫 줄의 `<` 규칙에도 이미 걸리지만, 뜻이 드러나게
// 따로 적어둔다). 아래 두 줄은 태그를 붙이기 전(0.4.10 이하) ctb 가 넣은 문구 — 지난 기록에는
// 그대로 남아 있어서 지우면 안 된다.
const PREVIEW_SKIP = new RegExp([
  /^\s*[<[]/,                                    // 슬래시 명령 출력·메타 줄
  /^Caveat:/,                                    // 주의 문구
  /^<ctb:/,                                      // ctb 가 끼워 넣은 턴
  /^A local terminal coding session just ended/, // 옛 ctb (영)
  /^방금 로컬 터미널 코딩 세션이 끝났어/,          // 옛 ctb (한)
].map((r) => r.source).join("|"));

// Codex 는 프롬프트 앞에 규칙·persona 를 붙여 보내므로(runCodex 참고) 미리보기에선 걷어낸다.
function sessionPreview(text) {
  const body = text.includes("User request:") ? text.slice(text.indexOf("User request:") + 13) : text;
  const line = stripMsgMeta(body).replace(/\s+/g, " ").trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

// Claude 기록 폴더는 프로젝트 경로를 인코딩한 이름(`/Users/x/y` → `-Users-x-y`)인데 비공식
// 규칙이라 바뀔 수 있다. 그래서 이름으로 먼저 찾고, 없으면 각 폴더의 jsonl 에 박혀 있는
// cwd 로 되짚는다 — 규칙이 바뀌어도 목록이 통째로 사라지지는 않게.
function claudeSessionDir() {
  const root = join(process.env.HOME || "", ".claude", "projects");
  const guess = join(root, resolve(cfg.projectDir).replace(/[^a-zA-Z0-9]/g, "-"));
  if (existsSync(guess)) return guess;
  let dirs;
  try { dirs = readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const full = join(root, d);
    let files;
    try { files = readdirSync(full).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    if (!files.length) continue;
    if (readHead(join(full, files[0]), 8192).includes(`"cwd":"${resolve(cfg.projectDir)}"`)) return full;
  }
  return null;
}

function claudeSessions() {
  const dir = claudeSessionDir();
  if (!dir) return [];
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  return files
    .map((f) => {
      try { return { id: f.slice(0, -6), path: join(dir, f), at: statSync(join(dir, f)).mtimeMs }; }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, SESSION_LIST_MAX)
    .map((s) => ({ ...s, preview: claudeSessionPreview(s.path) }));
}

// 미리보기는 첫 메시지가 아니라 **마지막** 사용자 메시지다. 며칠 이어온 세션일수록 "뭘로
// 시작했나" 보다 "뭘 하다 말았나" 가 알아보기 쉽고, 버튼에 같이 붙는 시각(mtime)과도 같은
// 시점을 가리킨다. 꼬리에서 쓸 만한 줄을 못 찾으면 앞부분으로 물러선다.
function claudeSessionPreview(path) {
  return claudePreviewFrom(readTail(path).split("\n").reverse()) || claudePreviewFrom(readHead(path).split("\n"));
}

function claudePreviewFrom(lines) {
  for (const line of lines) {
    if (!line.includes('"type":"user"')) continue;
    let content;
    try { content = JSON.parse(line)?.message?.content; } catch { continue; }
    if (Array.isArray(content)) content = content.find((c) => c?.type === "text")?.text;
    if (typeof content !== "string") continue;
    // 판정은 메타를 걷어낸 뒤에 한다 — 순서가 바뀌면 그룹방 메시지가 `[From: …]` 때문에 전부 걸린다.
    const body = stripMsgMeta(content);
    if (PREVIEW_SKIP.test(body)) continue;
    const preview = sessionPreview(body);
    if (preview) return preview;
  }
  return "";
}

// Codex 는 날짜별 폴더(YYYY/MM/DD)에 전 프로젝트가 섞여 쌓인다. 대신 첫 줄 session_meta 에
// cwd 가 들어 있어 경로 인코딩을 추측할 필요가 없다 — 최신 파일부터 훑다가 필요한 만큼 찾으면 멈춘다.
function codexSessions() {
  const root = join(process.env.HOME || "", ".codex", "sessions");
  const paths = [];
  const walk = (dir, depth) => {
    if (paths.length >= SESSION_SCAN_MAX) return;
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names.sort().reverse()) { // 최신 연·월·일, 파일명도 시각순이라 역순이 최신
      if (paths.length >= SESSION_SCAN_MAX) return;
      if (depth < 3) walk(join(dir, n), depth + 1);
      else if (n.endsWith(".jsonl")) paths.push(join(dir, n));
    }
  };
  walk(root, 0);
  // 파일명은 만든 시각이라 정렬 기준으로 못 쓴다 — `codex exec resume` 은 원본 파일에 계속
  // 덧붙이므로, 7월에 만든 세션이 어제 쓴 세션일 수 있다. mtime(마지막 사용)으로 줄 세우고
  // 그 순서대로 앞부분만 읽어 cwd 를 확인한다(stat 은 싸고 읽기는 비싸다).
  const out = [];
  const byRecent = paths
    .map((path) => { try { return { path, at: statSync(path).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
  for (const { path, at } of byRecent) {
    if (out.length >= SESSION_LIST_MAX) break;
    const head = readHead(path);
    if (!head.includes(`"cwd":"${resolve(cfg.projectDir)}"`)) continue;
    let id;
    for (const line of head.split("\n")) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e?.type === "session_meta") { id = e.payload?.id; break; }
    }
    if (!id) continue;
    const preview =
      codexPreviewFrom(readTail(path).split("\n").reverse()) || codexPreviewFrom(head.split("\n"));
    out.push({ id, path, at, preview });
  }
  return out;
}

function codexPreviewFrom(lines) {
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.payload?.type !== "user_message" || typeof e.payload.message !== "string") continue;
    const preview = sessionPreview(e.payload.message);
    if (preview) return preview;
  }
  return "";
}

// 세션 이름 — 미리보기는 마지막 메시지라 대화가 이어질수록 계속 바뀐다. 오래 붙잡아 둘 세션은
// 직접 이름을 달아두는 편이 확실하다. 세션 ID 는 방과 무관하게 유일하니 봇 전역에 저장한다.
const sessionName = (id) => (id && state.sessionNames?.[id]) || "";

function sessionAge(ms, l) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (min < 1) return l === "ko" ? "방금" : "just now";
  if (min < 60) return l === "ko" ? `${min}분 전` : `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return l === "ko" ? `${hr}시간 전` : `${hr}h ago`;
  return l === "ko" ? `${Math.round(hr / 24)}일 전` : `${Math.round(hr / 24)}d ago`;
}

// 작업이 얼마나 돌았는지 — sessionAge 와 달리 시각이 아니라 **경과 시간(ms)** 을 받아 길이를 준다.
function jobElapsed(ms, l) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return l === "ko" ? "1분 미만" : "under a minute";
  if (min < 60) return l === "ko" ? `${min}분` : `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return l === "ko" ? `${hr}시간` : `${hr}h`;
  return l === "ko" ? `${Math.round(hr / 24)}일` : `${Math.round(hr / 24)}d`;
}

// /(슬래시) 자동완성 메뉴용 명령 목록 (언어별). setMyCommands 로 등록.
const COMMANDS = {
  en: [
    { command: "new", description: "Reset context (new session)" },
    { command: "newchat", description: "New topic + fresh session there (forum groups) · same as /newtopic" },
    { command: "sessions", description: "List past sessions · pick one to carry on from" },
    { command: "name", description: "Name the current session" },
    { command: "jobs", description: "Background jobs still running (survive replies)" },
    { command: "persona", description: "The role this room runs as, and the prompt behind it" },
    { command: "tell", description: "Hand a message to another room this bot runs · lists rooms if used alone" },
    { command: "compact", description: "Compress context to free up space (keeps session)" },
    { command: "plan", description: "Plan only (no edits) · on|off to pin plan mode to this room" },
    { command: "ollama", description: "Toggle Ollama chat mode (bypass Claude, use local LLM)" },
    { command: "stop", description: "Stop the current task (--reset to roll back session)" },
    { command: "local", description: "Which room a local ctb session holds · end it" },
    { command: "remember", description: "Save to persistent memory (survives /new)" },
    { command: "memory", description: "View memory · rm <n> drops lines (3-9 ok) · clear wipes it" },
    { command: "cron", description: "List / add / remove scheduled tasks" },
    { command: "restart", description: "Restart the bot (after syntax check)" },
    { command: "status", description: "Bot status / version" },
    { command: "provider", description: "View / switch this room's provider" },
    { command: "model", description: "View / switch this room's model" },
    { command: "autocompact", description: "View / set the auto-compact token threshold" },
    { command: "mergewindow", description: "View / set how long to wait for a follow-up message" },
    { command: "reserve", description: "Schedule retry when usage limit resets · /reserve rm to cancel" },
    { command: "id", description: "Show this chat ID" },
    { command: "help", description: "Help" },
  ],
  ko: [
    { command: "new", description: "대화 맥락 초기화 (새 세션)" },
    { command: "newchat", description: "새 주제를 만들어 거기서 새 세션 시작 (주제 켜진 그룹) · /newtopic 도 같음" },
    { command: "sessions", description: "지난 세션 목록 · 골라서 이어가기" },
    { command: "name", description: "지금 세션에 이름 붙이기" },
    { command: "jobs", description: "백그라운드 작업 목록 (답장 후에도 살아 있는 것)" },
    { command: "persona", description: "이 방이 어떤 역할로 도는지와 그 프롬프트 본문" },
    { command: "tell", description: "이 봇이 맡은 다른 방으로 메시지 넘기기 · 인자 없으면 방 목록" },
    { command: "compact", description: "컨텍스트 압축 (세션 유지, 공간 확보)" },
    { command: "plan", description: "계획만 세우기 (편집 없음) · on|off 로 이 방에 고정" },
    { command: "ollama", description: "Ollama 채팅 모드 토글 (Claude 우회, 로컬 LLM)" },
    { command: "stop", description: "작업 중단 (--reset 으로 세션 되돌리기)" },
    { command: "local", description: "로컬 ctb 세션이 잡은 방 확인·종료" },
    { command: "remember", description: "퍼시스턴트 메모리에 저장 (/new 후에도 유지)" },
    { command: "memory", description: "메모리 보기 · rm <번호>로 삭제(3-9 가능) · clear로 전체" },
    { command: "cron", description: "예약 작업 보기·추가·삭제" },
    { command: "restart", description: "봇 재시작 (문법 검사 후)" },
    { command: "status", description: "봇 상태·버전 보기" },
    { command: "provider", description: "이 방의 provider 보기·전환" },
    { command: "model", description: "이 방의 모델 보기·전환" },
    { command: "autocompact", description: "자동 압축 임계값 보기·설정" },
    { command: "mergewindow", description: "다음 메시지를 기다리는 시간 보기·설정" },
    { command: "reserve", description: "한도 리셋 시 재시도 예약 · /reserve rm 으로 취소" },
    { command: "id", description: "이 채팅 ID 확인" },
    { command: "help", description: "도움말" },
  ],
};

// ── 로컬 세션 lock ────────────────────────────────────────────────────────
// ctb 실행 시 .claude-bot/local.lock 을 만들고 종료 시 지운다. 봇은 provider 를 띄우기 전에 이걸
// 보고 같은 세션을 양쪽에서 동시에 --resume 하는 걸 막는다. PID 가 이미 죽었으면(stale) 지우고 진행.
//
// 락은 **그 방에만** 걸린다. 세션은 방마다 따로고 토픽끼리도 병렬로 도는데, 락만 봇 전체를 잠그면
// DM 에서 터미널 작업 중이라는 이유로 그룹 토픽까지 멈춰 선다 — 막을 이유가 없는 조합이다.
// 파일은 첫 줄이 PID, 둘째 줄이 나머지 정보(JSON)다 — 옛 봇이 첫 줄만 읽어도 깨지지 않게 나눠 뒀다.
// 0.4.13 이전 ctb 는 PID 한 줄만 적어서 어느 방인지 알 수 없다. 그때는 예전처럼 전 방을 잠근다.
const LOCAL_LOCK_PATH = join(BOT_DIR, "local.lock");
function readLocalLock() {
  if (!existsSync(LOCAL_LOCK_PATH)) return null;
  try {
    const [head, rest] = readFileSync(LOCAL_LOCK_PATH, "utf8").split("\n");
    const pid = parseInt(head, 10);
    process.kill(pid, 0); // throws if process is dead
    let room;
    try { room = JSON.parse(rest)?.room; } catch {}
    return { pid, room: room ? String(room) : undefined };
  } catch {
    try { unlinkSync(LOCAL_LOCK_PATH); } catch {} // stale — remove
    return null;
  }
}
function checkLocalLock(chatId) {
  const lock = readLocalLock();
  if (!lock) return false;
  return !lock.room || lock.room === String(chatId);
}
// 로컬 세션 정보 — PID·생성 시각(경과 분)·어느 방인지. 방 이름은 목록과 같은 걸 쓴다.
function localLockInfo() {
  const lock = readLocalLock();
  if (!lock) return null;
  const mins = Math.max(0, Math.round((Date.now() - statSync(LOCAL_LOCK_PATH).mtimeMs) / 60000));
  const where = lock.room ? state.sessions?.[lock.room]?.title || lock.room : "";
  return { pid: lock.pid, mins, room: lock.room, where };
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
    if (!readLocalLock()) return { ok: true, pid: info.pid };
    await new Promise((r) => setTimeout(r, 250));
  }
  signal("SIGKILL");
  for (let i = 0; i < 8; i++) {
    if (!readLocalLock()) return { ok: true, pid: info.pid, forced: true };
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
// 항목이 늘어나면 토큰보다 주목도가 문제다 — RULES 블록을 persona 앞에 두고 "must follow before
// anything else" 를 붙여도, 그 안에 스무 줄이 있으면 신호가 평평해져 기존 규칙까지 약해진다.
// 그래서 MEMORY_CROWDED 를 넘으면 /remember 응답에 정리 권유를 붙인다.

// 방이 가리키는 페르소나. **고르지 않은 방은 기본값(personas[0])으로 돈다** — 프롬프트와 메모리가
// 같은 페르소나를 가리켜야 하므로 그 판단을 여기 한 곳에서 한다. 목록이 없으면 null 이라 경로도
// 주입도 예전 그대로다. 없는 id(config 에서 지운 뒤)도 기본값으로 떨어진다.
// chatBucket 이 아니라 state 를 직접 읽는다 — 경로 하나 고르려고 빈 방 버킷을 만들 이유가 없다.
// chatId 가 없는 호출(cron)도 기본값이다. → docs/design/room-personas.md
function roomPersona(chatId) {
  if (!PERSONAS.length) return null;
  const id = chatId == null ? null : state.sessions?.[String(chatId)]?.persona;
  return (id && PERSONAS.find((p) => p.id === id)) || PERSONAS[0];
}
// 시스템 프롬프트에 실릴 역할 본문. 페르소나를 안 쓰면 예전처럼 cfg.persona 다.
const personaPrompt = (chatId) => roomPersona(chatId)?.prompt ?? cfg.persona;
const memoryPath = (chatId) => memoryPathFor(roomPersona(chatId)?.id);

function loadMemory(chatId) {
  try { return readFileSync(memoryPath(chatId), "utf8").trim(); } catch { return ""; }
}
function saveMemory(chatId, content) {
  writeFileSync(memoryPath(chatId), content);
}
// 메모리는 `- ` 항목 목록. 여러 줄짜리 항목은 첫 줄만 `- ` 로 시작하므로 뒤따르는 줄은 앞 항목에 붙인다.
// (손으로 편집해 불릿이 없는 파일도 항목으로 받아들여 다시 쓸 때 정규화된다.)
function memoryItems(mem) {
  const items = [];
  let bulleted = false; // 불릿이 하나도 없는 파일이면 줄 단위로 끊는다 — 안 그러면 통째로 한 항목이 된다.
  for (const line of mem.split("\n")) {
    if (line.startsWith("- ")) { items.push(line.slice(2)); bulleted = true; }
    else if (bulleted && items.length) items[items.length - 1] += `\n${line}`;
    else if (line.trim()) items.push(line.trim());
  }
  return items;
}
function saveMemoryItems(chatId, items) {
  saveMemory(chatId, items.map((s) => `- ${s}`).join("\n"));
}
// 번호를 붙여 보여준다 — /memory rm <번호> 로 지우기 위한 것. 여러 줄 항목은 이어지는 줄을 들여쓴다.
function memoryNumbered(items) {
  return items.map((s, i) => `${i + 1}. ${s.split("\n").join("\n   ")}`).join("\n");
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
function currentProvider(chatId) {
  return (chatId !== undefined ? chatBucket(chatId).provider : undefined) || DEFAULT_PROVIDER;
}

// 그룹 승격으로 물려받은 채팅 ID (adoptMigratedChat 참고). config.json 은 봇이 고칠 수 없으니
// state 에 남겨서 재시작 후에도 화이트리스트가 유지되게 한다.
for (const id of state.adoptedChatIds || []) if (!allowedIds.includes(id)) allowedIds.push(id);

// ── 방(chatId)별 세션 ─────────────────────────────────────────────────────
// 같은 봇이 여러 방(DM·그룹)을 담당할 때 방마다 대화 맥락과 provider/model override 를 분리한다.
// Claude와 Codex 세션은 서로 호환되지 않으므로 방마다 sessionId와 codexSessionId를 따로 저장한다.
// ollamaMode·자동 compact 같은 운영 설정만 state 최상위에 둔다.
//
// 포럼(주제) 그룹에서는 토픽 하나가 곧 방이다 — 방 키를 "chatId:threadId" 로 확장해 토픽마다
// 세션·대기열을 따로 둔다. 토픽이 아닌 방(DM·일반 그룹·General 토픽)의 키는 예전 그대로 "chatId"
// 라서 기존 state.sessions 가 그대로 읽힌다(마이그레이션 불필요). 아래 코드의 chatId 인자에는
// 이 방 키가 그대로 들어가고, 텔레그램 API 를 부를 때만 tgTarget() 으로 되돌린다.
const roomKey = (chatId, threadId) => (threadId ? `${chatId}:${threadId}` : String(chatId));
// 일반 supergroup 도 답글 스레드에 message_thread_id 를 붙이므로, 포럼 토픽을 뜻하는
// is_topic_message 가 있을 때만 방을 나눈다 (안 그러면 답글마다 세션이 쪼개진다).
const roomOf = (msg) => roomKey(msg?.chat?.id, msg?.is_topic_message ? msg.message_thread_id : undefined);
// 방 키 → 텔레그램 전송 대상. chatId 는 숫자(그룹은 음수)라 ":" 와 겹치지 않는다.
function tgTarget(room) {
  const s = String(room);
  const i = s.indexOf(":");
  return i < 0 ? { chat_id: s } : { chat_id: s.slice(0, i), message_thread_id: Number(s.slice(i + 1)) };
}
// 화이트리스트 검사·리액션·버튼 수정처럼 토픽과 무관한 곳에 쓸 실제 채팅 ID.
const baseChatId = (room) => tgTarget(room).chat_id;
// 입력중 표시 전용 대상. 포럼 그룹의 General 토픽은 is_topic_message 가 붙지 않아 방 키에 접미사가
// 없는데, sendChatAction 만은 스레드를 안 적으면 "모두" 뷰에만 뜨고 정작 General 안에서는 보이지
// 않는다 (메시지 전송은 안 적어도 General 로 잘 들어간다 — 그래서 이 표시만 티가 안 났다).
// General 의 스레드 ID 는 1 이다. 포럼이 아닌 방에 1 을 붙이면 오히려 실패하므로, 포럼이라고
// 확인된 방에만 붙인다.
function typingTarget(room) {
  const target = tgTarget(room);
  if (target.message_thread_id === undefined && state.sessions?.[target.chat_id]?.forum)
    target.message_thread_id = 1;
  return target;
}

function chatBucket(chatId) {
  if (!state.sessions) state.sessions = {};
  const k = String(chatId);
  if (!state.sessions[k]) state.sessions[k] = {};
  return state.sessions[k];
}
const sidKey = (provider = DEFAULT_PROVIDER) => (provider === "codex" ? "codexSessionId" : "sessionId");
function getSid(chatId, provider = currentProvider(chatId)) {
  return chatBucket(chatId)[sidKey(provider)];
}
function setSid(chatId, id, provider = currentProvider(chatId)) {
  chatBucket(chatId)[sidKey(provider)] = id;
  recordSessionPersona(chatId, id);
}
// jsonl 은 페르소나를 모르므로 봇이 따로 적는다(`sessionNames` 와 같은 자리). 새 세션 ID 를 만드는
// 경로가 전부 setSid 를 지나므로 여기 한 곳이면 compact 로 ID 가 갈리는 경우까지 덮인다.
//
// **이미 찍힌 세션은 다시 찍지 않는다.** 그래서 `/sessions` 로 페르소나 미상인 옛 세션을 채택하면
// 그 방의 역할로 낙인이 찍히고, 이후 그 역할 목록에만 뜬다 — 의도한 동작이다. 다른 역할이 찍힌
// 세션은 애초에 목록에 안 뜨므로 이 자리는 미상에만 해당한다.
const SESSION_PERSONA_MAX = SESSION_LIST_MAX * 8;
function recordSessionPersona(chatId, id) {
  if (!PERSONAS.length || !id) return;
  const map = (state.sessionPersona = state.sessionPersona || {});
  if (map[id]) return;
  map[id] = roomPersona(chatId)?.id;
  // Claude 는 실행마다 새 세션 ID 를 만들어서, 안 지우면 이 표가 대화량에 비례해 영구히 자란다.
  // 오래된 쪽부터 버린다(객체는 삽입 순서를 지킨다). 목록은 provider 당 최근 10개만 보므로
  // 넉넉히 남겨도 유한하다 — 직전 것만 남기면 목록에 뜨는 세션이 전부 미상이 되어 거를 수가 없다.
  const keys = Object.keys(map);
  // slice 의 끝 인자가 음수면 "뒤에서 N번째"가 되어, 상한에 닿기 전부터 앞쪽을 잘라낸다.
  if (keys.length > SESSION_PERSONA_MAX)
    for (const k of keys.slice(0, keys.length - SESSION_PERSONA_MAX)) delete map[k];
}
const sessionPersonaOf = (id) => (id && state.sessionPersona?.[id]) || "";

// 방 이름 — state 에는 방 키(숫자)만 남아서 터미널에서 어느 방인지 알아볼 방법이 없었다.
// 메시지가 올 때 화면에 보이는 이름을 같이 적어둔다. 토픽 이름만은 일반 메시지에 실려 오지 않고
// 생성·수정 서비스 메시지에만 붙으므로, 여기와 newTopic() 두 군데에서 잡는다.
//
// 이름의 출처는 신뢰도가 갈린다. 서비스 메시지(생성·이름 변경)와 /newchat 은 **그 순간의 진짜
// 이름**이라 언제든 덮어쓴다(strong). 반면 답글에 딸려 오는 생성 정보는 **만들 당시 이름의
// 스냅샷**이라 그 뒤 바뀐 이름을 모르고, `#11` 은 아예 이름을 못 구했을 때의 임시값이다(weak).
// weak 로 덮어쓰게 두면 이름을 바꿔 반영해 놓아도 누군가 토픽 첫 메시지에 답장하는 순간 옛 이름으로
// 되돌아간다 — 그래서 weak 는 아직 아는 이름이 없을 때만 쓴다.
function roomTitleOf(msg, topicName) {
  const c = msg.chat || {};
  // 이미 있던 토픽은 서비스 메시지가 지나간 뒤라 이름을 얻을 통로가 없다 — 답글 대상으로 딸려 오는
  // 생성 메시지가 유일한 뒷문이다(토픽 첫 메시지에 붙는다). 그마저 없으면 `#11` 로 적어 둔다.
  // 그룹 이름만 적으면 General 과 구별이 안 되고, 비워 두면 목록에서 무엇인지 알 길이 없다.
  const name = topicName || msg.reply_to_message?.forum_topic_created?.name;
  if (msg.is_topic_message || name) {
    return {
      title: [c.title, name || `#${msg.message_thread_id}`].filter(Boolean).join(" / "),
      weak: !topicName,
    };
  }
  const title = c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || "";
  return { title, weak: false };
}
function rememberRoomTitle(room, title, weak) {
  if (!title) return;
  const bucket = chatBucket(room);
  if (bucket.title === title) return;
  if (weak && bucket.title) return;
  bucket.title = title;
  saveState(state);
}
// 포럼 여부는 방마다가 아니라 채팅 단위 성질이라 그룹 ID 쪽 버킷에 적어 둔다 — General 의 방 키가
// 곧 그 그룹 ID 라, typingTarget() 이 접미사 없는 키로 그대로 찾아 쓴다.
function rememberForum(chatId) {
  const bucket = chatBucket(chatId);
  if (bucket.forum) return;
  bucket.forum = true;
  saveState(state);
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

// 0.4.13 이하의 provider/model override 는 봇 전체 공용이었다. 기존에 알려진 각 방으로
// 복사한 뒤 최상위 키를 지워, 업그레이드 직후에는 동작이 그대로이면서 이후 변경은 방별로 갈린다.
if (state.provider || state.model || state.codexModel) {
  if (!state.sessions) state.sessions = {};
  for (const id of allowedIds) if (!state.sessions[id]) state.sessions[id] = {};
  for (const bucket of Object.values(state.sessions || {})) {
    if (state.provider && !bucket.provider) bucket.provider = state.provider;
    if (state.model && !bucket.model) bucket.model = state.model;
    if (state.codexModel && !bucket.codexModel) bucket.codexModel = state.codexModel;
  }
  delete state.provider;
  delete state.model;
  delete state.codexModel;
  saveState(state);
}

function currentModel(chatId, provider = currentProvider(chatId)) {
  const key = provider === "codex" ? "codexModel" : "model";
  return chatId !== undefined ? chatBucket(chatId)[key] : undefined;
}

// plan 모드 고정 — 켜 두면 이 방의 모든 메시지가 `--permission-mode plan` 으로 돈다.
// provider·model 과 같은 자리에 두는 방 설정이라 재시작 후에도 유지된다.
const planLocked = (chatId) => Boolean(chatId !== undefined && chatBucket(chatId).planLock);

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

// iOS 키보드의 스마트 문장부호는 `--` 를 em 대시(—) 하나로 바꿔버린다. 그래서 `/new --chat` 이
// `/new —chat` 으로 도착하고, 어느 명령에도 안 걸려서 그대로 Claude 프롬프트로 흘러간다
// (Claude 쪽 /new 는 /clear 별칭이라 세션이 조용히 날아간다). 명령어 메시지에 한해 되돌린다.
// 뒤에 소문자 ASCII 가 붙은 것만 — `/remember 회의 — 결론` 같은 본문 대시는 건드리지 않는다.
function normalizeDashFlags(text) {
  if (!text.startsWith("/")) return text;
  return text.replace(/(^|\s)[—–](?=[a-z]{2,})/g, "$1--");
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
  const target = tgTarget(chatId); // 방 키가 토픽까지 담고 있으면 그 토픽으로 보낸다
  let lastId = null;
  for (let i = 0; i < cs.length; i++) {
    const isLast = i === cs.length - 1;
    const body = {
      ...target,
      text: mdToTelegramHtml(cs[i]),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (isLast && opts.replyMarkup) body.reply_markup = opts.replyMarkup;
    let r = await tg("sendMessage", body);
    // If our HTML is malformed for some edge case, resend as plain text.
    if (!r || r.ok === false) {
      const plain = { ...target, text: cs[i], disable_web_page_preview: true };
      if (isLast && opts.replyMarkup) plain.reply_markup = opts.replyMarkup;
      r = await tg("sendMessage", plain);
    }
    if (r?.ok) lastId = r.result?.message_id;
  }
  return lastId;
}

// ── 설정 메뉴 버튼의 수명 ────────────────────────────────────────────────
// 모델·프로바이더·자동압축·세션 목록 버튼은 '보낸 시점의 상태'를 그린 스냅샷이다. 대화가 이어지면
// 위로 밀려 올라갈 뿐 계속 눌리는 상태로 남아서, 스크롤을 올려 옛 메뉴를 누르면 그 사이 바꿔둔
// 값이 조용히 되돌아간다. 그래서 방마다 살아 있는 메뉴는 하나만 두고, 다음 입력이 오면 걷어낸다.
// 계획 승인(`plan:`)·로컬 종료(`local:kill`)는 아직 답을 안 받은 요청이라 여기 넣지 않는다 —
// 그 둘은 눌러야 끝나고, 눌린 뒤에는 handleCallback 이 알아서 버튼을 지운다.
const liveMenus = new Map(); // 방 키 → message_id

async function sendMenu(chatId, text, replyMarkup) {
  const id = await send(chatId, text, { replyMarkup });
  if (id) liveMenus.set(chatId, id);
  return id;
}

// 버튼 제거는 텔레그램 왕복이라 기다리지 않는다 — 새 입력 처리가 이것 때문에 늦어질 이유가 없다.
function dropLiveMenu(chatId) {
  const id = liveMenus.get(chatId);
  if (!id) return;
  liveMenus.delete(chatId);
  tg("editMessageReplyMarkup", {
    chat_id: baseChatId(chatId),
    message_id: id,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

// ── 모르는 방에서의 첫 인사 ───────────────────────────────────────────────
// 봇을 새 그룹에 초대해도 `allowedChatId` 에 없으면 그 방의 메시지는 로그에만 남고 조용히 버려졌다.
// 부른 사람 눈에는 봇이 죽은 것과 구분이 안 되고, 넣어야 할 chatId 를 알아낼 방법도 없었다 —
// `/id` 조차 화이트리스트 뒤에 있어서 답이 없다. 그래서 모르는 방에서는 넣을 값과 넣을 자리를 알려준다.
// **방 하나당 딱 한 번만** 말한다: 아무나 봇을 그룹에 끌어다 넣을 수 있어서, 메시지마다 답하면
// 봇이 스팸 중계기가 된다. 이 안내로 새는 건 그 방 스스로의 chatId 뿐이라 비밀이 아니다.
const GUIDE_URL = "https://github.com/JongtaekChoi/claude-telegram-bot/blob/main/docs/group-setup";
const greetedRooms = new Set(); // 이미 안내한 방 (프로세스 수명 — 재시작하면 한 번 더 말한다)

async function greetUnknownRoom(roomKey, rawChatId, from, l) {
  const key = String(rawChatId);
  if (greetedRooms.has(key)) return;
  if (greetedRooms.size >= 200) greetedRooms.delete(greetedRooms.values().next().value); // 가장 오래된 것부터
  greetedRooms.add(key);
  // 설정 파일 경로에는 계정 이름 같은 게 묻어 있다 — 허용된 방의 주인일 때만 실제 경로를 알린다.
  const isOwner = allowedIds.includes(String(from?.id));
  const guide = `${GUIDE_URL}${l === "ko" ? ".ko" : ""}.md`;
  await send(roomKey, t(l, "roomNotAllowed", key, isOwner ? CONFIG_PATH : "config.json", guide)).catch(() => {});
}

// 봇의 가입·탈퇴(my_chat_member)는 privacy mode 와 무관하게 항상 오는 업데이트다. 초대 직후 여기서
// 안내하면, privacy mode 가 켜져 있어 일반 대화가 봇에게 아예 닿지 않는 방에서도 chatId 를 알려줄 수 있다.
async function handleMyChatMember(upd) {
  const status = upd.new_chat_member?.status;
  if (status !== "member" && status !== "administrator") return; // 강퇴·탈퇴는 알릴 게 없다
  if (!upd.chat?.id || upd.chat.type === "private") return; // DM 의 차단/해제도 이 업데이트로 온다
  if (allowedIds.includes(String(upd.chat.id))) return; // 이미 허용된 방이면 조용히 들어간다
  await greetUnknownRoom(String(upd.chat.id), upd.chat.id, upd.from, langOf(upd));
}

// ── 이미지 전송(아웃박스) ──────────────────────────────────────────────────
// multipart/form-data 로 sendPhoto (Node 18+ 내장 FormData/Blob, 의존성 0 유지).
async function tgSendPhoto(chatId, absPath, caption) {
  const fd = new FormData();
  const target = tgTarget(chatId);
  fd.append("chat_id", String(target.chat_id));
  if (target.message_thread_id) fd.append("message_thread_id", String(target.message_thread_id));
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
  // 옆방 전달 마커를 먼저 떼고 이미지 마커를 뗀다 — 둘 다 사용자에게 보이면 안 되는 지시문이다.
  const { text: relayClean, tells } = extractRelayTells(text);
  const { text: clean, images } = extractOutboxImages(relayClean);
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
  // 전달은 답을 다 보낸 뒤에 건다 — 대상 방에 물음이 먼저 뜨고 정작 이 방의 답이 나중에 오면
  // 무슨 말에 딸린 전달인지 알 수 없다. opts.relayed 면 여기서 끊긴다(홉 1).
  for (const tell of tells) {
    try {
      await offerRelay(chatId, tell, opts.relayed);
    } catch (e) {
      console.error(`Relay error (${tell.token}):`, e.message);
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

// 작업 기록에 "어느 방으로 알릴지"를 적으려면 에이전트가 방 번호를 알아야 한다. 시스템 프롬프트에
// 실으면 매 턴 토큰을 먹으니 env 로 넘긴다. 방이 없는 경로(예약 작업)엔 넣지 않고, 그 경우 감시자가
// allowedIds[0] 로 폴백한다.
const jobEnv = (chatId) => ({
  ...process.env,
  ...(cfg.env || {}),
  ...(JOBS && chatId ? { CTB_CHAT_ID: String(chatId) } : {}),
});

// 에이전트에게 오래 걸리는 작업 띄우는 법을 알려주는 시스템 프롬프트 조각.
// 스킬이 아니라 시스템 프롬프트인 이유: 스킬은 에이전트가 "관련 있다"고 판단해야 로드된다. 안 걸리면
// run_in_background 를 써서 작업이 죽는데, 그게 바로 이 규칙이 막으려는 일이다. 항상 켜져 있어야 한다.
function jobInstruction() {
  return `Background work in this chat: your process exits when this reply is sent, and anything you `
    + `started with run_in_background dies with it.\n`
    + `- Work you will read back BEFORE replying (a quick build, a test run you wait on): run_in_background is fine.\n`
    + `- Work that must OUTLIVE this reply (dev servers, long builds, watchers, anything you report back on later): `
    + `detach it from this process and register it, or it will be killed.\n\n`
    + `To detach and register, run this as ONE Bash call from ${cfg.projectDir || DATA_DIR} `
    + `(one call so $! still refers to the job when the record is written):\n`
    + `  nohup <command> > .ctb-jobs/<name>.log 2>&1 & PID=$!; disown; echo "{\\"pid\\":$PID,\\"cmd\\":\\"<command>\\",\\"log\\":\\"<name>.log\\",\\"chat\\":\\"$CTB_CHAT_ID\\",\\"at\\":$(date +%s000)}" > .ctb-jobs/<name>.json\n`
    + `Use a short bare <name> (letters, digits, dash) — same name for both files, no subfolders. `
    + `The bot watches these records and messages this chat when the job exits, so tell the user the job name `
    + `and that they will be notified. They can also check with /jobs.`;
}

// ── 방 사이 전달 (/tell) ──────────────────────────────────────────────────
// 방마다 세션이 독립이라(0.4.3) 옆방이 알아낸 걸 가져올 통로가 없었다. 여기서 메시지 하나를 넘긴다.
// 사람이 친 `/tell` 은 바로 실행하고, 에이전트가 마커로 부른 건 받는 방에서 승인을 받는다 —
// 모델이 스스로 다른 방의 토큰을 쓰기 시작하는 자리라서다. → docs/design/room-relay.md
//
// 이 봇이 아는 방 = state 에 이름이 적혔고(= 한 번은 대화했고) 화이트리스트 안에 있는 방.
// 이름은 목록·지목에 쓰는 유일한 표식이라, 이름이 없는 방은 아예 후보에 넣지 않는다.
function knownRooms() {
  return Object.entries(state.sessions || {})
    .filter(([room, b]) => b?.title && allowedIds.includes(String(baseChatId(room))))
    .map(([room, b]) => ({ room, title: b.title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
const roomLabel = (room) => state.sessions?.[String(room)]?.title || String(room);
// 목록은 번호로 지목할 수 있어야 한다 — 폰에서 `큐브기획방 / 마케팅` 을 치게 할 수는 없다.
// 돌고 있는 방에는 ⏳ 를 붙인다(넘겨도 그 방 대기열에 쌓일 뿐이라 막지는 않는다).
const roomLines = (rooms) =>
  rooms
    .map((r, i) => `${i + 1}. ${r.title}${chatRuntime.get(String(r.room))?.busy ? " ⏳" : ""}`)
    .join("\n");

// 지목 문자열 → 방. 방 키 그대로 · 목록 번호 · 이름의 일부 순으로 본다.
// 방 키는 6자리 이상이거나 음수(그룹)라 3자리 이하 번호와 겹치지 않는다.
function resolveRoom(token, rooms) {
  const exact = rooms.find((r) => r.room === token);
  if (exact) return { room: exact };
  if (/^\d{1,3}$/.test(token)) {
    const n = Number(token);
    if (n >= 1 && n <= rooms.length) return { room: rooms[n - 1] };
  }
  const needle = token.toLowerCase();
  const hits = rooms.filter((r) => r.title.toLowerCase().includes(needle));
  if (hits.length === 1) return { room: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return {};
}

// 전달된 프롬프트의 머리말. 이게 없으면 받는 세션은 사용자가 한 말로 착각한다.
// 맨 앞이 `[` 라 본문이 `/` 로 시작해도 handle() 이 명령으로 해석하지 않는다.
const relayPrompt = (from, text) =>
  `[Relayed from: ${roomLabel(from)} — another room of this bot, passed on by the person using it]\n`
  + `Answer here, in this room. This is not the user typing to you directly, and you cannot pass it on again.\n\n`
  + text;

// 대상 방에서 실행한다. 합성 메시지를 handle() 에 넣을 뿐이라 큐·busy 락·provider·plan 고정은
// 전부 그 방 것을 그대로 따른다. `_drained` 는 병합 창에 다시 붙잡히지 않게 하는 표시.
async function runRelay(from, to, text) {
  const target = tgTarget(to);
  const msg = {
    chat: { id: target.chat_id },
    text: relayPrompt(from, text),
    _drained: true,
    _relay: String(from),
  };
  if (target.message_thread_id !== undefined) {
    msg.is_topic_message = true;
    msg.message_thread_id = target.message_thread_id;
  }
  await send(to, t(BOT_LANG, "tellIncoming", roomLabel(from)) + `\n\n${text}`);
  await handle(msg);
}

// 에이전트가 부른 전달은 받는 방에서 승인을 받는다. 계획 승인과 같은 성질이라 메모리에만 둔다 —
// 재시작하면 사라지고, 그 뒤에 눌러도 만료 안내가 나간다.
const pendingTells = new Map(); // id → { from, to, text }
const PENDING_TELL_MAX = 20;
let tellSeq = 0;
async function askRelay(from, to, text, l) {
  const id = String(++tellSeq);
  pendingTells.set(id, { from, to, text });
  if (pendingTells.size > PENDING_TELL_MAX) pendingTells.delete(pendingTells.keys().next().value);
  await send(to, t(BOT_LANG, "tellAsk", roomLabel(from), text), {
    replyMarkup: {
      inline_keyboard: [[
        { text: t(BOT_LANG, "tellApprove"), callback_data: `tl:y:${id}` },
        { text: t(BOT_LANG, "tellReject"), callback_data: `tl:n:${id}` },
      ]],
    },
  });
  await send(from, t(l, "tellAskSent", roomLabel(to)));
}

// 답변 텍스트에서 [[ctb-tell: 방 | 메시지]] 마커를 뽑아내고, 마커는 텍스트에서 제거한다.
const TELL_MARKER = /\[\[ctb-tell:\s*([^\]|]+?)\s*\|\s*([^\]]+?)\s*\]\]/g;
function extractRelayTells(text) {
  const tells = [];
  if (!ROOM_RELAY || !text || !text.includes("[[ctb-tell:")) return { text: text || "", tells };
  const clean = String(text)
    .replace(TELL_MARKER, (_m, room, body) => {
      const token = String(room).trim();
      const msg = String(body).trim().slice(0, 3000);
      if (token && msg) tells.push({ token, text: msg });
      return ""; // 유효하든 아니든 마커 자체는 사용자에게 노출하지 않는다
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: clean, tells };
}

// 마커 하나를 처리한다. 전달받아 돈 턴(relayed)이면 여기서 끊는다 — 홉은 1 이다.
async function offerRelay(from, tell, relayed) {
  const rooms = knownRooms().filter((r) => r.room !== String(from));
  const hit = rooms.length ? resolveRoom(tell.token, rooms) : {};
  if (!hit.room) {
    await send(from, rooms.length ? t(BOT_LANG, "tellUnknownRoom", roomLines(rooms)) : t(BOT_LANG, "tellNoRooms"));
    return;
  }
  if (relayed) {
    await send(from, t(BOT_LANG, "tellNoHop", hit.room.title));
    return;
  }
  if (state.sessions?.[hit.room.room]?.muted) {
    await send(from, t(BOT_LANG, "tellMuted", hit.room.title));
    return;
  }
  await askRelay(from, hit.room.room, tell.text, BOT_LANG);
}

// 에이전트에게 옆방에 메시지 넘기는 법을 알려주는 시스템 프롬프트 조각.
// 넘길 방이 실제로 있을 때만 붙인다 — 방이 하나뿐인 봇은 이 토큰을 내지 않는다.
function tellInstruction(chatId) {
  const rooms = knownRooms().filter((r) => r.room !== String(chatId));
  if (!rooms.length) return null;
  return `Other rooms this same bot runs, which you can hand a message to: ${rooms.map((r) => `"${r.title}"`).join(", ")}.\n`
    + `To hand one over, add a line at the very END of your reply in this exact form:\n`
    + `[[ctb-tell: ROOM | MESSAGE]]\n`
    + `ROOM is any distinctive part of the room name. The marker line is stripped from your visible reply, `
    + `someone in that room has to approve before it runs, it runs there with that room's own session, and the `
    + `answer stays there — you will not get a reply back. Only do this when the user asks you to pass something `
    + `to another room.`;
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
    const model = currentModel(opts.chatId, "claude") || cfg.model;
    const brevity =
      cfg.appendSystemPrompt ??
      "This reply is delivered over Telegram. Be concise — short paragraphs and lists, no filler intro/summary, avoid large tables. Reply in the user's language.";
    // opts.modelHint: 현재 모델을 주입 → 답변 끝에 상위 모델 권유 제안(판단은 Claude 본인)
    const modelHint = opts.modelHint
      ? `Current model: ${model || "claude (default)"}. Model tiers (low→high): haiku → sonnet → opus → fable. If this question seems to require more capability than the current model, append one short line at the very end of your reply: 💡 \`/model sonnet\` (or \`/model opus\`, \`/model fable\`) for a stronger answer. Omit the suggestion for simple questions.`
      : null;
    // opts.injectMemory: 퍼시스턴트 메모리를 시스템 프롬프트에 주입 (/new 로 초기화해도 유지)
    const mem = opts.injectMemory ? loadMemory(opts.chatId) : "";
    // 메모리는 persona보다 앞에 배치하고 헤더를 강화 → persona가 덮어쓰는 것 방지
    const memoryBlock = mem ? `## RULES (must follow before anything else)\n${mem}` : null;
    const handoff = opts.injectHandoff !== false ? loadCodexHandoff() : "";
    const handoffBlock = handoff
      ? `## CODEX FALLBACK HANDOFF\nClaude and Codex sessions are separate. The notes below summarize work Codex handled while Claude was unavailable; use them as context, not as your own prior messages.\n${handoff}`
      : null;
    const imageHint = IMAGE_SEND ? imageSendInstruction() : null;
    const jobHint = JOBS ? jobInstruction() : null;
    // 넘길 방이 없으면 null 이라 방 하나짜리 봇은 이 토큰을 내지 않는다.
    const tellHint = ROOM_RELAY ? tellInstruction(opts.chatId) : null;
    const appendSys = [memoryBlock, handoffBlock, personaPrompt(opts.chatId), brevity, modelHint, imageHint, jobHint, tellHint].filter(Boolean).join("\n\n");
    if (appendSys) args.push("--append-system-prompt", appendSys);
    if (model) args.push("--model", model);
    if (sessionId) args.push("--resume", sessionId);
    // -p와 프롬프트는 맨 끝에 — 터미널 테스트에서 검증된 순서
    // `--` 구분자로 `-`로 시작하는 프롬프트도 옵션으로 오해 안 함
    args.push("-p", "--", prompt);

    const child = spawn(cfg.claudeBin || "claude", args, {
      cwd: cfg.projectDir,
      env: jobEnv(opts.chatId),
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
    const model = currentModel(opts.chatId, "codex") || cfg.codexModel;
    const timeoutMs = cfg.codexTimeout || 600_000;
    const args = ["exec"];
    const resumeSessionId = opts.sessionId; // 세션은 방별로 관리 — 호출부가 명시적으로 넘긴다
    let codexPrompt = prompt;
    if (opts.injectMemory) {
      // Codex 에는 --append-system-prompt 가 없어 프롬프트 앞에 붙인다. 새 세션이면 persona 까지
      // 한 번에 싣고, 이어가는 세션이면 메모리만 매 턴 다시 싣는다 — 세션이 시작된 뒤 /remember 로
      // 추가한 규칙이 그 세션에는 영영 안 들어가던 문제. (Claude 는 매 호출 --append-system-prompt
      // 로 들어가므로 원래 이 구멍이 없다.)
      const mem = loadMemory(opts.chatId);
      const context = resumeSessionId
        ? (mem ? `## RULES (must follow before anything else)\n${mem}` : "")
        : [mem, personaPrompt(opts.chatId), cfg.appendSystemPrompt, IMAGE_SEND ? imageSendInstruction() : null, JOBS ? jobInstruction() : null,
           ROOM_RELAY ? tellInstruction(opts.chatId) : null].filter(Boolean).join("\n\n");
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
      env: jobEnv(opts.chatId),
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
  if (currentProvider(opts.chatId) === "codex") {
    return runCodex(prompt, opts.lang || BOT_LANG, {
      noHeader: true,
      trackChild: opts.trackChild,
      injectMemory: opts.injectMemory,
      recordHandoff: opts.recordHandoff,
      chatId: opts.chatId, // 작업 기록에 적을 방 번호 (CTB_CHAT_ID 로 전달)
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
    const appendSys = [personaPrompt(opts.chatId), brevity, fallbackRole].filter(Boolean).join("\n\n");
    // `--` 앞은 ollama launch 플래그, 뒤는 claude 플래그로 전달된다.
    const claudeArgs = ["--output-format", "json"];
    if (appendSys) claudeArgs.push("--append-system-prompt", appendSys);
    if (opts.sessionId) claudeArgs.push("--resume", opts.sessionId);
    claudeArgs.push("-p", "--", prompt);
    const args = ["launch", "claude", "--model", model, "--yes", "--", ...claudeArgs];

    const child = spawn(resolveOllamaBin(), args, {
      cwd: cfg.projectDir,
      env: jobEnv(opts.chatId),
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
  // 예약 작업은 방이 아니라 전용 슬롯에서 돈다 — 어느 방의 로컬 세션이든 있으면 건너뛴다.
  if (r.busy || readLocalLock()) {
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

// ── 백그라운드 작업 감시 (.ctb-jobs) ──────────────────────────────────────
// 작업은 봇의 자식이 아니다. 에이전트가 nohup 으로 프로세스 그룹 밖에 내보내고, 봇은 주기적으로
// pid 의 생사만 확인한다 — kill(pid, 0) 은 신호를 보내지 않고 존재 여부만 던진다(없으면 ESRCH).
// 덕분에 감시자가 무상태다: 봇을 재시작해도 작업은 살아 있고 폴더만 다시 읽으면 감시가 이어진다.

function jobRecords() {
  try {
    return readdirSync(JOBS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((file) => {
        try {
          const rec = JSON.parse(readFileSync(join(JOBS_DIR, file), "utf8"));
          return typeof rec?.pid === "number" ? { ...rec, file, name: basename(file, ".json") } : null;
        } catch {
          return null; // 에이전트가 쓰다 만 파일 — 다음 틱에 다시 본다
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function jobAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 로그는 기록에 적힌 이름을 그대로 믿지 않는다 — basename 만 취해 JOBS_DIR 밖으로 못 나가게 한다
// (아웃박스 파일명 검증과 같은 방식).
const jobLogPath = (rec) => (rec.log ? join(JOBS_DIR, basename(String(rec.log))) : null);

async function sweepJobs() {
  for (const rec of jobRecords()) {
    if (rec.done || jobAlive(rec.pid)) continue;
    // 알리기 **전에** 완료로 표시한다 — 전송이 실패해도 다음 틱에 또 보내지 않게.
    try {
      writeFileSync(join(JOBS_DIR, rec.file), JSON.stringify({ ...rec, file: undefined, name: undefined, done: Date.now() }));
    } catch (e) {
      console.error(`Job sweep: cannot mark ${rec.file}:`, e.message);
      continue;
    }
    const chat = rec.chat || allowedIds[0];
    if (!chat) continue;
    const logPath = jobLogPath(rec);
    const tail = logPath ? readTail(logPath, JOB_LOG_TAIL).trim() : "";
    const ran = rec.at ? jobElapsed(Date.now() - rec.at, BOT_LANG) : "";
    await send(chat, t(BOT_LANG, "jobDone", rec.name, rec.cmd || "", ran, tail)).catch((e) =>
      console.error("Job notify failed:", e.message),
    );
  }
}

function startJobWatcher() {
  if (!JOBS) return;
  // 로컬 ctb 잠금은 보지 않는다 — 터미널에서 작업 중이어도 빌드가 끝나면 알리는 게 맞다.
  const tick = () => sweepJobs().catch((e) => console.error("Job sweep error:", e.message));
  tick(); // 부팅 직후 1회: 봇이 죽어 있는 동안 끝난 작업을 여기서 회수한다
  setInterval(tick, JOB_TICK_MS);
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
    await sendMenu(chatId, t(l, "autoCompactStatus", cur, def), {
      inline_keyboard: [
        AUTOCOMPACT_PRESETS.map(btn),
        [
          { text: t(l, "autoCompactOffBtn"), callback_data: "ac:off" },
          { text: t(l, "autoCompactDefBtn"), callback_data: "ac:default" },
        ],
      ],
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

// /mergewindow — 인자 없으면 현재값 + 프리셋 버튼, 있으면 설정. 버튼 콜백(mw:*)도 같은 경로를 탄다.
// 손에 맞는 길이는 몇 번 바꿔봐야 나오는데(두 줄째를 치는 속도가 사람마다 다르다), config 에만 두면
// 그때마다 재시작이라 결국 안 만지게 된다. 그래서 state 에 저장하고 버튼으로 바꾼다.
const MERGE_WINDOW_PRESETS = ["0.5s", "1s", "2s", "3s", "5s"];
// 너무 짧으면 있으나 마나고(두 줄째를 치기 전에 창이 닫힌다), 너무 길면 한 줄만 보낸 사람이 봇이
// 죽은 줄 안다. 끄는 건 `off` 로 명시해야 한다 — 1ms 로 사실상 꺼두는 길은 열어두지 않는다.
const MERGE_WINDOW_MIN = 100;
const MERGE_WINDOW_MAX = 30000;
async function handleMergeWindow(chatId, arg, l) {
  if (!arg) {
    const btn = (p) => ({ text: p, callback_data: `mw:${p}` });
    await sendMenu(chatId, t(l, "mergeWindowStatus", mergeWindowMs(), MERGE_WINDOW_DEFAULT), {
      inline_keyboard: [
        MERGE_WINDOW_PRESETS.map(btn),
        [
          { text: t(l, "mergeWindowOffBtn"), callback_data: "mw:off" },
          { text: t(l, "mergeWindowDefBtn"), callback_data: "mw:default" },
        ],
      ],
    });
    return;
  }
  if (arg === "default" || arg === "reset") {
    state.mergeWindowMs = undefined;
    saveState(state);
    await send(chatId, t(l, "mergeWindowReset", MERGE_WINDOW_DEFAULT));
    return;
  }
  if (arg === "off") {
    state.mergeWindowMs = 0;
    saveState(state);
    await send(chatId, t(l, "mergeWindowOff"));
    return;
  }
  const n = parseDuration(arg);
  if (!Number.isFinite(n) || n < 0) {
    await send(chatId, t(l, "mergeWindowUsage"));
    return;
  }
  if (n < MERGE_WINDOW_MIN || n > MERGE_WINDOW_MAX) {
    await send(chatId, t(l, "mergeWindowRange", n, MERGE_WINDOW_MIN, MERGE_WINDOW_MAX));
    return;
  }
  state.mergeWindowMs = n;
  saveState(state);
  await send(chatId, t(l, "mergeWindowSet", n));
}

// 임계값 초과 시 압축할지 묻는다 — 버튼 콜백은 `cp:*`.
async function askAutoCompact(chatId, ctxTokens, l) {
  await sendMenu(chatId, t(l, "autoCompactAsk", roundTokens(ctxTokens)), {
    inline_keyboard: [[
      { text: t(l, "autoCompactNowBtn"), callback_data: "cp:yes" },
      { text: t(l, "autoCompactLaterBtn"), callback_data: `cp:later:${ctxTokens}` },
      { text: t(l, "autoCompactOffBtn"), callback_data: "ac:off" },
    ]],
  });
}

// "나중에"를 누르면 지금보다 이만큼 더 커지기 전까지 다시 묻지 않는다.
// 그냥 한 번 넘기기만 하면 다음 턴에 또 물어서 결국 같은 성가심이 된다.
const AUTOCOMPACT_SNOOZE_RATIO = 1.25;
// fmtTokens 는 1000 으로 안 나눠지면 원본 숫자를 그대로 찍는다. 컨텍스트 추정치는 132453 처럼
// 어중간한 값이라 그대로 보여주면 정밀해 보이지만 어차피 추정치다 — k 단위로 반올림해서 보여준다.
const roundTokens = (n) => Math.max(Math.round(n / 1000), 1) * 1000;

// 승인 대기 때문에 미뤄둔 압축 물음을 꺼낸다 — 계획이 취소·만료돼 더는 무효화할 승인이 없을 때다.
// 승인해서 실행된 경우는 그 실행이 끝나며 스스로 다시 판단하므로 여기서 부르지 않는다.
async function flushCompactAsk(chatId, l) {
  const r = rt(chatId);
  const n = r.compactAsk;
  if (!n) return;
  r.compactAsk = 0;
  if (currentProvider(chatId) !== "claude" || !getSid(chatId, "claude")) return;
  // 미루기 전 자리는 handle() 안(busy=true)이라 doCompact 를 직접 불렀지만 여기는 락 밖이다.
  if (cfg.autoCompactConfirm === false) await runCompact(chatId, l, "autoCompact");
  else if (n > (state.autoCompactSnooze || 0)) await askAutoCompact(chatId, n, l);
}

// 실제 압축 — 락은 호출자가 잡는다. 자동 압축 트리거는 이미 handle() 안(busy=true)이라
// 여기를 직접 부르고, 버튼·명령은 아래 runCompact() 를 거친다.
async function doCompact(chatId, l, okKey) {
  // 압축이 세션을 갈아치우고 나면 살아 있었는지 물을 수 없다 — 먼저 봐 둔다.
  const hadPlan = planAwaitingApproval(chatId);
  const r = rt(chatId);
  const gen = r.gen;
  try {
    const cr = await runClaude("/compact", getSid(chatId, "claude"), { chatId });
    // 압축 도중 `/new` 가 들어왔으면 압축 결과 세션도 버린다 — 그것도 옛 맥락의 후속이다.
    if (cr.sessionId) commitSid(r, gen, chatId, cr.sessionId, "claude");
    // 압축해도 임계값 아래로 안 내려갈 수 있다. 그때 snooze 를 지워버리면 바로 다음 턴에 또 물어서
    // 무한 반복이 되므로, 압축 직후 컨텍스트를 기준으로 다시 걸어둔다.
    state.autoCompactSnooze = cr.ctxTokens ? roundTokens(cr.ctxTokens * AUTOCOMPACT_SNOOZE_RATIO) : undefined;
    saveState(state);
    if (cr.ok !== false) {
      await send(chatId, t(l, okKey));
      // 압축은 세션을 갈아치워 떠 있던 승인 버튼을 무효로 만든다 — 조용히 사라지면 나중에 눌러 보고서야 안다.
      if (hadPlan) {
        pendingPlans.delete(chatId);
        await send(chatId, t(l, "planExpiredByCompact"));
      }
    } else await send(chatId, t(l, "compactFail", cr.text));
  } catch (e) {
    await send(chatId, t(l, "compactFail", e.message));
  }
}

// 버튼(`cp:yes`)과 /compact 에서 부르는 압축 — busy 락·타이핑 표시를 handle() 과 같은 패턴으로 처리.
// 락 없이 돌리면 압축이 도는 2분 사이에 들어온 메시지가 같은 세션에 동시 투입돼 답이 통째로 사라진다.
async function runCompact(chatId, l, okKey) {
  if (currentProvider(chatId) !== "claude") { await send(chatId, t(l, "compactProviderUnsupported")); return; }
  if (!getSid(chatId, "claude")) { await send(chatId, t(l, "compactNoSession")); return; }
  const r = rt(chatId);
  if (r.busy) {
    r.queue.push({ msg: { chat: { id: chatId }, text: "/compact" }, receivedAt: Date.now() });
    await send(chatId, t(l, "queued", r.queue.length));
    return;
  }
  if (checkLocalLock(chatId)) {
    await send(chatId, t(l, "localBusy"), { replyMarkup: localKillMarkup(l) });
    return;
  }
  r.busy = true;
  r.typing = setInterval(
    () => tg("sendChatAction", { ...typingTarget(chatId), action: "typing" }).catch(() => {}),
    TYPING_TICK_MS,
  );
  try {
    // 압축은 오래 걸린다 — 즉시 응답이 없으면 버튼이 안 먹은 것처럼 보인다.
    await send(chatId, t(l, "compacting"));
    await doCompact(chatId, l, okKey);
  } finally {
    clearInterval(r.typing);
    r.typing = null;
    r.busy = false;
    if (r.queue.length > 0 && !roomRateLimited(chatId)) setImmediate(() => handle(drainQueue(chatId)));
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
    const cur = currentProvider(chatId);
    await sendMenu(chatId, t(l, "providerStatus", cur, DEFAULT_PROVIDER), {
      inline_keyboard: [[
        ...PROVIDERS.map((p) => ({ text: p === cur ? `✅ ${p}` : p, callback_data: `pv:${p}` })),
        { text: t(l, "providerDefBtn"), callback_data: "pv:default" },
      ]],
    });
    return;
  }
  const previousProvider = currentProvider(chatId);
  const bucket = chatBucket(chatId);
  if (arg === "default" || arg === "reset") {
    bucket.provider = undefined;
    saveState(state);
    await send(chatId, t(l, "providerReset", DEFAULT_PROVIDER));
    resumeQueueAfterProviderSwitch(chatId, previousProvider);
    return;
  }
  if (!PROVIDERS.includes(arg)) {
    await send(chatId, t(l, "providerUsage"));
    return;
  }
  bucket.provider = arg;
  state.ollamaMode = false;
  saveState(state);
  // 고정은 지우지 않는다 — provider 와 같은 방 설정이라 조용히 사라지면 그게 더 놀랍다. 다만
  // Codex 에는 걸리지 않으므로, 파일이 다시 수정된다는 걸 전환하는 자리에서 크게 알린다.
  const codexWarn = arg === "codex" && planLocked(chatId) ? t(l, "planLockCodexWarn") : "";
  await send(chatId, t(l, "providerSet", arg) + codexWarn);
  resumeQueueAfterProviderSwitch(chatId, previousProvider);
}

// plan 고정 확인·전환 — /plan on|off 와 버튼(`pl:*`)이 모두 여기로 온다.
// 인자 없는 `/plan` 은 현재 상태 + 전환 버튼. 켜 두면 이 방의 모든 메시지가 계획부터 세운다.
async function handlePlanLock(chatId, arg, l) {
  if (!arg) {
    const on = planLocked(chatId);
    await sendMenu(chatId, t(l, "planLockStatus", on), {
      inline_keyboard: [[
        on
          ? { text: t(l, "planLockOffBtn"), callback_data: "pl:off" }
          : { text: t(l, "planLockOnBtn"), callback_data: "pl:on" },
      ]],
    });
    return;
  }
  const on = arg === "on";
  chatBucket(chatId).planLock = on || undefined;
  saveState(state);
  // Codex 방에서 켜면 아무 일도 일어나지 않는다 — 켜졌다고만 알리면 보호받는 줄 착각한다.
  const codexWarn = on && currentProvider(chatId) === "codex" ? t(l, "planLockCodexWarn") : "";
  await send(chatId, t(l, on ? "planLockOn" : "planLockOff") + codexWarn);
}

// 모델 확인·전환 — /model 과 버튼(`md:*`)이 모두 여기로 온다.
// Claude 는 별칭 버튼을 주고, Codex 는 CLI의 계정별 모델 캐시를 버튼으로 보여준다.
// 버튼에 표시 시점의 provider 를 실어 보낸다 — 누르기 전에 /provider 로 바꿔도 엉뚱한 쪽에 저장되지 않게.
async function handleModel(chatId, arg, l, provider = currentProvider(chatId)) {
  const modelStateKey = provider === "codex" ? "codexModel" : "model";
  const configuredModel = provider === "codex" ? cfg.codexModel : cfg.model;
  const codexModels = provider === "codex" ? codexModelSuggestions() : [];
  if (!arg) {
    const cur = chatBucket(chatId)[modelStateKey] || configuredModel || (l === "ko" ? "(기본값)" : "(default)");
    const btn = (text, v) => ({ text, callback_data: `md:${provider}:${v}` });
    const defRow = [btn(t(l, "modelDefBtn"), "default")];
    const codexRows = [];
    for (let i = 0; i < codexModels.length; i += 2) {
      codexRows.push(codexModels.slice(i, i + 2).map((m) => btn(m === cur ? `✅ ${m}` : m, m)));
    }
    await sendMenu(
      chatId,
      provider === "codex" ? t(l, "codexModelStatus", cur, codexModels) : t(l, "claudeModelStatus", cur),
      {
        inline_keyboard: provider === "codex"
          ? [...codexRows, defRow]
          : [CLAUDE_MODEL_SUGGESTIONS.map((m) => btn(m === cur ? `✅ ${m}` : m, m)), defRow],
      },
    );
    return;
  }
  if (arg === "default" || arg === "reset") {
    chatBucket(chatId)[modelStateKey] = undefined;
    saveState(state);
    await send(chatId, t(l, "modelReset", provider, configuredModel || (l === "ko" ? "기본값" : "default")));
    return;
  }
  chatBucket(chatId)[modelStateKey] = arg;
  saveState(state);
  // 목록에 없어도 막지는 않는다 — 캐시는 Codex CLI 가 갱신하는 파일이라, 새로 나온 모델을 아직
  // 못 받았을 수 있다. 여기서 차단하면 정당한 모델을 텔레그램에서 영영 못 고른다. 경고만 남긴다.
  if (provider === "codex" && codexModels.length > 0 && !codexModels.includes(arg)) {
    await send(chatId, t(l, "codexModelUnknown", arg, codexModels));
    return;
  }
  await send(chatId, t(l, "modelSet", provider, arg));
}

// 지난 세션 목록·전환 — /sessions 와 버튼(`ss:*`)이 모두 여기로 온다.
// 목록은 항상 현재 provider 기준이다. Claude 세션과 Codex 세션은 서로 호환되지 않아서
// 섞어 보여주면 고르는 순간 사고다. 다른 방이 쓰고 있는 세션은 자물쇠를 달고 막는다 —
// 한 기록 파일에 두 프로세스가 붙으면 양쪽 맥락이 서로를 덮어쓴다.
async function handleSessions(chatId, arg, l, provider = currentProvider(chatId), msgId) {
  if (rt(chatId).busy) {
    await send(chatId, t(l, "busy"));
    return;
  }
  if (arg) {
    // 이미 쓰고 있는 세션을 다시 고르는 건 흔한 오조작이다 — 그냥 넘기면 "바꿨다"고만 나와서
    // 안 바뀐 걸 바뀐 줄 안다. 아무 일도 안 일어났다고 분명히 말해준다.
    if (arg === getSid(chatId, provider)) {
      await send(chatId, t(l, "sessionAlready", sessionName(arg) || `${arg.slice(0, 8)}…`));
      return;
    }
    if (sessionsHeldElsewhere(chatId, provider).has(arg)) {
      await send(chatId, t(l, "sessionHeld"));
      return;
    }
    if (sessionsRunningInTerminal().has(arg)) {
      await send(chatId, t(l, "sessionInTerminal"));
      return;
    }
    // 찍기 전에 봐야 한다 — setSid 가 미상 세션에 이 방의 역할을 박는다.
    const wasUnknown = PERSONAS.length && !sessionPersonaOf(arg);
    setSid(chatId, arg, provider);
    saveState(state);
    await send(chatId, t(l, "sessionSwitched", provider, sessionName(arg) || `${arg.slice(0, 8)}…`)
      + (wasUnknown ? `\n\n${t(l, "sessionPersonaUnknown", roomPersona(chatId).name)}` : ""));
    // 목록 메시지는 그대로 두고 ✅ 만 옮겨 그린다 — 되돌아가서 다시 고를 수 있어야 하니까.
    if (msgId)
      tg("editMessageReplyMarkup", {
        chat_id: baseChatId(chatId),
        message_id: msgId,
        reply_markup: sessionKeyboard(chatId, provider, l),
      }).catch(() => {});
    return;
  }
  const kb = sessionKeyboard(chatId, provider, l);
  if (!kb.inline_keyboard.length) {
    await send(chatId, t(l, "sessionsEmpty", provider));
    return;
  }
  const header = t(l, "sessionsHeader", provider, kb.inline_keyboard.length)
    + (PERSONAS.length ? `\n${t(l, "sessionsPersonaNote", roomPersona(chatId).name)}` : "");
  await sendMenu(chatId, header, kb);
}

// 다른 방이 붙잡고 있는 세션 — 한 기록 파일에 두 프로세스가 붙으면 서로의 맥락을 덮어쓴다.
function sessionsHeldElsewhere(chatId, provider) {
  return new Set(
    Object.entries(state.sessions || {})
      .filter(([k]) => k !== String(chatId))
      .map(([, b]) => b?.[sidKey(provider)])
      .filter(Boolean),
  );
}

// 터미널에서 열려 있는 세션. state.json 은 이 봇이 어느 방에 어느 세션을 물려놨는지만 알아서,
// 같은 프로젝트를 터미널(`claude --resume …`, `codex exec resume …`)에서 열어둔 경우를 못 본다.
// 다른 방이든 다른 창이든 한 기록 파일에 두 프로세스가 붙는 건 똑같으므로 여기서 같이 막는다.
// ps 한 번이면 되고, 실패하면 빈 집합 — 안 보이던 이전 상태로 돌아갈 뿐 목록이 죽지는 않는다.
const SESSION_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function sessionsRunningInTerminal() {
  let out;
  try { out = execFileSync("ps", ["-Ao", "args="], { encoding: "utf8", timeout: 3000 }); }
  catch { return new Set(); }
  const ids = new Set();
  for (const line of out.split("\n")) {
    // 봇이 띄운 자식 프로세스도 여기 걸리지만, 그 세션은 이미 ✅ 아니면 🔒 라 표시가 밀리지 않는다.
    if (!/\bresume\b/.test(line)) continue;
    for (const id of line.match(SESSION_ID_RE) || []) ids.add(id);
  }
  return ids;
}

// 목록은 디스크의 jsonl 을 프로젝트 폴더 기준으로 훑어 만든다 — 그래서 **이 프로젝트의 모든 방
// 세션이 한 목록에 섞여 나온다.** 페르소나가 붙으면 이게 "역할은 세션 경계에서만" 규칙의 뒷문이
// 된다: 기획 맥락이 쌓인 세션을 개발 역할로 이어받으면 정면 충돌이다. 그래서 다른 역할이 찍힌
// 세션은 목록에서 뺀다. 역할이 안 찍힌 옛 세션(미상)은 ❓ 를 달아 남긴다 — 빼 버리면 페르소나를
// 도입하는 순간 이력이 통째로 사라진다. → docs/design/room-personas.md
function sessionKeyboard(chatId, provider, l) {
  const cur = getSid(chatId, provider);
  const held = sessionsHeldElsewhere(chatId, provider);
  const running = sessionsRunningInTerminal();
  const mine = roomPersona(chatId)?.id;
  const list = (provider === "codex" ? codexSessions() : claudeSessions())
    .filter((s) => !mine || !sessionPersonaOf(s.id) || sessionPersonaOf(s.id) === mine);
  return {
    inline_keyboard: list.map((s) => {
      const mark = s.id === cur ? "✅ " : held.has(s.id) ? "🔒 " : running.has(s.id) ? "💻 " : "";
      const unknown = mine && !sessionPersonaOf(s.id) ? "❓ " : "";
      // 이름을 붙여둔 세션은 이름이 미리보기를 밀어낸다 — 일부러 달아둔 쪽이 더 확실한 표시다.
      const name = sessionName(s.id);
      const label = `${mark}${unknown}${sessionAge(s.at, l)} · ${name ? `🏷 ${name}` : s.preview || s.id.slice(0, 8)}`;
      return [{ text: label, callback_data: `ss:${provider}:${s.id}` }];
    }),
  };
}

// 세션 이름 붙이기 — /name. 이름은 세션에 붙고 방에 붙지 않는다(세션을 옮기면 이름도 따라간다).
async function handleName(chatId, arg, l) {
  const id = getSid(chatId);
  if (!id) {
    await send(chatId, t(l, "nameNoSession"));
    return;
  }
  const names = (state.sessionNames = state.sessionNames || {});
  if (!arg) {
    await send(chatId, names[id] ? t(l, "nameCurrent", names[id]) : t(l, "nameUsage"));
    return;
  }
  if (arg === "-" || arg === "off") {
    delete names[id];
    saveState(state);
    await send(chatId, t(l, "nameCleared"));
    return;
  }
  names[id] = arg.replace(/\s+/g, " ").slice(0, 24); // 버튼 한 줄에 들어갈 만큼만
  saveState(state);
  await send(chatId, t(l, "nameSet", names[id]));
}

// 방별 페르소나 — 역할은 **세션 경계에서만** 정해진다. 맥락이 쌓인 세션의 정체성이 도중에 바뀌면
// 이미 쌓인 대화가 옛 페르소나의 것이라 모순되기 때문이다. 그래서 고르는 자리는 셋뿐이다:
// 처음 보는 방의 첫 대화 · /newchat · /new. 보는 건 /status 가 한다 — 보기 전용 명령을 따로
// 두느니 이미 있는 자리에 한 줄 붙이는 쪽이 낫다. → docs/design/room-personas.md
// 세션 경계인가 — 명령과 버튼이 **같은 판정**을 써야 한다. 살아 있는 세션이 있거나 지금 돌고
// 있으면 이미 그 역할로 맥락이 쌓이는 중이다. provider 를 바꿔 가며 쓰는 방이 있어 양쪽을 다
// 본다 — 한쪽만 비어도 이어갈 대화가 남아 있다.
//
// **선택 버튼의 "만료"가 이것이다.** 첫 대화에서 버튼을 띄우고 답을 그냥 진행시키므로, 사람이
// 뒤늦게 누르면 그건 미드-세션 변경이 된다. 타이머로 지우는 대신 누르는 순간 이 판정을 다시
// 하게 해서, 첫 턴이 시작된 뒤의 버튼은 저절로 무효가 된다.
function personaChangeable(chatId) {
  return !getSid(chatId, "claude") && !getSid(chatId, "codex")
    && !chatRuntime.get(String(chatId))?.busy;
}
async function applyPersona(chatId, persona, l) {
  const cur = roomPersona(chatId);
  if (persona.id === cur.id && chatBucket(chatId).persona) {
    await send(chatId, t(l, "personaSame", cur.name));
    return;
  }
  if (!personaChangeable(chatId)) {
    await send(chatId, t(l, "personaLocked", cur.name, persona.name));
    return;
  }
  chatBucket(chatId).persona = persona.id;
  saveState(state);
  await send(chatId, t(l, "personaSet", persona.name));
}
// /persona — **확인 전용.** 지금 이 방이 무슨 역할로 도는지와 그 프롬프트 본문을 보여준다.
// 바꾸는 건 세션 경계의 버튼만 한다. /status 의 한 줄로는 "무슨 지시를 받고 있는지"까지는
// 알 수 없어서, 본문을 직접 볼 자리가 하나는 있어야 한다.
const PERSONA_BODY_MAX = 600; // 폰에서 한 화면을 넘기지 않을 만큼만 — 나머지는 말줄임
async function handlePersona(chatId, l) {
  if (!PERSONAS.length) {
    await send(chatId, t(l, "personaOff"));
    return;
  }
  const cur = roomPersona(chatId);
  const body = cur.prompt.length > PERSONA_BODY_MAX
    ? `${cur.prompt.slice(0, PERSONA_BODY_MAX).trimEnd()}…`
    : cur.prompt;
  const others = PERSONAS.filter((p) => p.id !== cur.id).map((p) => p.name).join(" · ");
  await send(chatId, t(l, "personaShow", cur.name, cur.id, body, others));
}

// 역할 선택 버튼. 지금 역할에 ● 를 붙인다. 취소 버튼은 없다 — 안 고르고 그냥 말을 걸면 기본
// 역할로 진행되는 게 규칙이라, 취소는 이미 "아무것도 안 하기"로 있다.
async function sendPersonaMenu(chatId, l, key) {
  if (!PERSONAS.length) return false;
  const cur = roomPersona(chatId);
  const rows = [];
  for (let i = 0; i < PERSONAS.length; i += 2)
    rows.push(PERSONAS.slice(i, i + 2).map((p) => ({
      text: p.id === cur.id ? `● ${p.name}` : p.name,
      callback_data: `pa:${p.id}`,
    })));
  await sendMenu(chatId, t(l, key, cur.name), { inline_keyboard: rows });
  return true;
}
// /tell <방> <메시지> — 이 봇이 맡은 다른 방으로 메시지 하나를 넘긴다. 사람이 직접 친 것이므로
// 대상 방에 물어보지 않고 바로 실행한다(에이전트가 마커로 부르는 길만 승인을 받는다).
// 인자 없이 부르면 방 목록. → docs/design/room-relay.md
async function handleTell(chatId, arg, l) {
  if (!ROOM_RELAY) {
    await send(chatId, t(l, "tellOff"));
    return;
  }
  const all = knownRooms();
  const rooms = all.filter((r) => r.room !== String(chatId));
  if (!rooms.length) {
    await send(chatId, t(l, "tellNoRooms"));
    return;
  }
  const sp = arg.search(/\s/);
  const token = sp < 0 ? arg : arg.slice(0, sp);
  const body = sp < 0 ? "" : arg.slice(sp + 1).trim();
  if (!token) {
    await send(chatId, t(l, "tellList", roomLines(rooms)));
    return;
  }
  const hit = resolveRoom(token, rooms);
  if (hit.ambiguous) {
    await send(chatId, t(l, "tellAmbiguous", roomLines(hit.ambiguous)));
    return;
  }
  if (!hit.room) {
    // 자기 방 이름을 친 경우만은 "그런 방 없다"가 아니라 왜 없는지 알려준다 — 목록에서 뺀 쪽이다.
    const self = resolveRoom(token, all);
    await send(chatId, self.room?.room === String(chatId) ? t(l, "tellSelf") : t(l, "tellUnknownRoom", roomLines(rooms)));
    return;
  }
  if (!body) {
    await send(chatId, t(l, "tellUsage"));
    return;
  }
  if (state.sessions?.[hit.room.room]?.muted) {
    await send(chatId, t(l, "tellMuted", hit.room.title));
    return;
  }
  await send(chatId, t(l, "tellSent", hit.room.title));
  // 대상 방의 실행은 그 방 큐에서 알아서 돈다 — 여기서 기다리면 보낸 방이 그동안 묶인다.
  runRelay(chatId, hit.room.room, body).catch((e) => console.error("Relay run error:", e.message));
}

// /newchat (= /newtopic) — 새 포럼 토픽을 만들고 거기서 새 세션으로 시작한다. 봇 API 로는 그룹 자체를
// 만들 수 없어서(그룹 생성은 유저 계정 전용), "새 방"에 가장 가까운 게 주제(토픽)다. 슈퍼그룹에
// 주제가 켜져 있고 봇에 '주제 관리' 권한이 있어야 한다 — 실패 사유는 텔레그램 설명을 그대로 보여준다.
// 새 토픽의 방 키는 처음 보는 값이라(토픽 ID = 메시지 ID, 재사용 없음) 따로 세션을 비울 필요가 없다.
async function newTopic(chatId, name, l) {
  const base = baseChatId(chatId);
  if (!String(base).startsWith("-")) {
    await send(chatId, t(l, "newTopicNotGroup"));
    return;
  }
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const title = (name || t(l, "newTopicDefaultName", stamp)).replace(/\s+/g, " ").slice(0, 128);
  let r;
  try {
    r = await tg("createForumTopic", { chat_id: base, name: title });
  } catch (e) {
    r = { ok: false, description: e.message };
  }
  if (!r?.ok) {
    await send(chatId, t(l, "newTopicFail", r?.description || "unknown error"));
    return;
  }
  const room = roomKey(base, r.result.message_thread_id);
  // 이름을 확실히 아는 건 여기뿐이다 — 서비스 메시지 경로는 손으로 만든 토픽을 위한 보조 수단.
  rememberRoomTitle(room, [chatBucket(base).title, title].filter(Boolean).join(" / "));
  await send(room, t(l, "newTopicHello"));
  await sendPersonaMenu(room, l, "personaFirst"); // 새 방이라 아직 아무 맥락도 없다
  await send(chatId, t(l, "newTopicCreated", title));
}

// 백그라운드 작업 목록 — /jobs. 방을 가리지 않고 전부 보여준다. 작업은 방이 아니라 이 기계에
// 붙어 있고(로컬 ctb 에서 띄운 것도 여기 섞인다), 어느 방에서 띄웠든 돌고 있다는 사실이 중요하다.
async function handleJobs(chatId, l) {
  if (!JOBS) {
    await send(chatId, t(l, "jobsOff"));
    return;
  }
  const recs = jobRecords();
  if (!recs.length) {
    await send(chatId, t(l, "jobsEmpty"));
    return;
  }
  const running = [], finished = [];
  for (const rec of recs) (rec.done || !jobAlive(rec.pid) ? finished : running).push(rec);
  const line = (rec, mark) =>
    `${mark} \`${rec.name}\` · ${rec.at ? jobElapsed((rec.done || Date.now()) - rec.at, l) : "?"}` +
    (rec.cmd ? `\n   ${rec.cmd}` : "");
  const body = [
    ...running.map((r) => line(r, "▶")),
    ...finished.map((r) => line(r, "✅")),
  ].join("\n");
  await send(chatId, t(l, "jobsList", running.length, finished.length, body, JOBS_DIR));
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
  await send(chatId, t(l, "localActive", info.pid, info.mins, info.where), { replyMarkup: localKillMarkup(l) });
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
      await tg("sendChatAction", { ...typingTarget(chatId), action: "typing" });
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
  // 실패 사유는 텔레그램 description 을 그대로 노출한다 — 용량 초과("file is too big")인지 네트워크 문제인지 구분돼야 진단이 된다.
  if (!info.ok) throw new Error(info.description || "getFile failed");
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
const chatRuntime = new Map(); // chatId → { busy, child, typing, prevSession, stopping, queue, compactAsk, gen }
function rt(chatId) {
  const id = String(chatId);
  let r = chatRuntime.get(id);
  if (!r) {
    r = { busy: false, child: null, typing: null, prevSession: null, stopping: false, queue: [], compactAsk: 0, gen: 0 };
    chatRuntime.set(id, r);
  }
  return r;
}

// 실행이 끝나 세션 ID 를 등록하려는데, 그 사이 `/new` 가 맥락을 버렸으면 등록하지 않는다.
// `/new` 는 돌고 있어도 먹혀야 해서 명령 구간(busy 검사보다 앞)에서 처리되는데, 그때 돌던 실행이
// 끝나면서 후속 세션 ID 를 등록하면 **방금 버린 맥락이 그대로 되살아난다.** 사용자는 새 대화라고
// 안내받은 채 옛 맥락 위에서 계속 말하게 된다.
//
// 답장 자체는 그대로 보낸다 — 실행을 취소하는 건 `/stop` 의 일이고, `/new` 는 "다음 메시지부터
// 새로" 라는 뜻이다. 이미 돌던 답을 버리면 사용자가 시킨 적 없는 취소가 된다.
function commitSid(r, gen, chatId, id, provider) {
  if (gen !== undefined && r.gen !== gen) return false;
  setSid(chatId, id, provider);
  saveState(state);
  return true;
}
const CRON_KEY = "__cron__"; // 예약 작업 전용 실행 슬롯 (실제 chatId 와 겹치지 않음)
const mediaGroups = new Map(); // media_group_id → { msgs, timer } — 미디어 그룹 수집 대기
const pendingPlans = new Map(); // chatId → { sessionId, messageId } — /plan 승인 대기
// 실행할 때마다 세션 ID 가 바뀌므로 그 뒤에 남은 승인은 눌러도 만료다(runApprovedPlan 이 같은 걸 본다).
// 맵에 있는지가 아니라 아직 살아 있는지를 물어야 한다 — 죽은 승인 때문에 압축 물음을 미루면 영영 안 나온다.
const planAwaitingApproval = (chatId) =>
  pendingPlans.get(chatId)?.sessionId === getSid(chatId, "claude");
const PLAN_PROCEED_PROMPT = "Proceed with the plan you just approved above. Implement it now.";
let rateLimitUntil = null;  // 레이트 리밋 활성 시 리셋 Date — 이 시간까지 메시지를 큐에 쌓음
let rateLimitTimer = null;  // 리셋 시간에 큐를 드레인하는 타이머

// 모든 방의 대기열을 각자 드레인 (레이트리밋 해제 시). 방마다 독립 실행됨.
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

// 한도에 걸린 방만 다른 provider로 전환하면 그 방은 예약을 기다릴 이유가 없다.
// 다른 Claude 방의 한도 타이머는 유지하고, 전환한 방의 대기열만 Codex로 즉시 이어서 처리한다.
function roomRateLimited(chatId) {
  return currentProvider(chatId) === "claude" && rateLimitUntil && Date.now() < rateLimitUntil;
}

function resumeQueueAfterProviderSwitch(chatId, previousProvider) {
  if (previousProvider === currentProvider(chatId)) return;
  const r = rt(chatId);
  if (r.queue.length > 0 && !roomRateLimited(chatId)) setImmediate(() => handle(drainQueue(chatId)));
}

// runClaude 결과를 답장으로 변환 — 폴백/큐잉/자동 컴팩션 처리. handle()과 /plan 승인 실행이 공유.
async function replyWithClaudeResult(chatId, l, prompt, msg, res, started, planPending, gen) {
  const r = rt(chatId);
  const secs = Math.round((Date.now() - started) / 1000);
  if (!res.ok) {
    // plan 고정 중에는 폴백하지 않는다. Codex 에는 plan 모드가 없어서, 계획만 받으려던 요청이
    // 한도에 걸렸다는 이유로 파일을 고치는 실행으로 바뀐다 — 권한이 조용히 넓어지는 유일한 자리다.
    if (planLocked(chatId) && currentProvider(chatId) === "claude" && cfg.codexFallback && res.canFallback && !r.stopping) {
      await send(chatId, t(l, "planLockNoFallback"));
    }
    // Codex 폴백: 레이트리밋·크레딧 에러이고 codexFallback 켜져 있으면 reserve 전에 Codex로 재시도
    else if (currentProvider(chatId) === "claude" && cfg.codexFallback && res.canFallback && !r.stopping) {
      try {
        const cRes = await runCodex(prompt, l, { trackChild: r, sessionId: getSid(chatId, "codex"), chatId });
        if (cRes.ok) {
          if (cRes.sessionId) commitSid(r, gen, chatId, cRes.sessionId, "codex");
          await deliver(chatId, cRes.text, { relayed: Boolean(msg?._relay) }); return;
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
          sessionId: currentProvider(chatId) === "claude" ? getSid(chatId, "claude") : undefined,
          chatId,
        });
        if (oRes.ok) {
          if (oRes.sessionId) commitSid(r, gen, chatId, oRes.sessionId, "claude");
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
    // 전달받아 돈 턴이면 그 답에 또 전달 마커가 있어도 넘기지 않는다 — 홉은 1 이다(deliver 가 끊는다).
    if (!r.stopping) await deliver(chatId, res.text + footer, { relayed: Boolean(msg?._relay) });
    // 자동 컴팩션: 컨텍스트가 임계값을 넘으면 압축할지 물어본다. 예고 없이 압축이 돌면 대화
    // 맥락이 갑자기 요약본으로 바뀌어 흐름이 끊기므로, 기본은 확인을 받는 쪽이다.
    // config 의 autoCompactConfirm:false 로 예전처럼 묻지 않고 바로 압축하게 할 수 있다.
    const compactThreshold = state.autoCompactThreshold ?? cfg.autoCompactThreshold ?? 100000;
    if (currentProvider(chatId) === "claude" && compactThreshold > 0 && res.ctxTokens > compactThreshold && getSid(chatId, "claude") && !r.stopping) {
      // 승인 버튼이 이미 떠 있거나 이 답 바로 뒤에 붙을 참이면 물음을 미룬다. 압축은 세션을
      // 갈아치우므로 먼저 누르면 그 계획의 승인이 그 자리에서 만료된다(`planNoPending`) — 계획을
      // 읽는 동안이 사람이 가장 오래 머무는 자리라 겹치기 쉽고, plan 을 고정해 두면 매 턴 그렇게 된다.
      // 승인 대기가 등록되는 건 이 함수가 끝난 뒤라 맵만 봐서는 늦는다 — 부르는 쪽이 알려준다.
      if (planPending || planAwaitingApproval(chatId)) r.compactAsk = res.ctxTokens;
      else if (cfg.autoCompactConfirm === false) await doCompact(chatId, l, "autoCompact");
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
    await flushCompactAsk(chatId, l);
    return;
  }
  const r = rt(chatId);
  // 여기부터는 실행이 확정이다 — 끝나면서 replyWithClaudeResult 가 다시 판단하므로 미뤄둔 건 놓아준다.
  r.compactAsk = 0;
  if (r.busy) {
    // `_approvedPlan` 이 없으면 이 메시지가 나중에 handle() 로 드레인될 때 plan 고정에 다시 걸려
    // 승인 → 또 계획 → 승인 … 으로 영영 실행되지 않는다.
    r.queue.push({ msg: { chat: { id: chatId }, text: PLAN_PROCEED_PROMPT, _approvedPlan: true }, receivedAt: Date.now() });
    await send(chatId, t(l, "queued", r.queue.length));
    return;
  }
  if (checkLocalLock(chatId)) {
    await send(chatId, t(l, "localBusy"), { replyMarkup: localKillMarkup(l) });
    return;
  }
  r.busy = true;
  const started = Date.now();
  r.typing = setInterval(
    () => tg("sendChatAction", { ...typingTarget(chatId), action: "typing" }).catch(() => {}),
    TYPING_TICK_MS,
  );
  const syntheticMsg = { chat: { id: chatId }, text: PLAN_PROCEED_PROMPT };
  try {
    await tg("sendChatAction", { ...typingTarget(chatId), action: "typing" });
    r.prevSession = { chatId: String(chatId), provider: "claude", sessionId: getSid(chatId, "claude") };
    const gen = r.gen; // 실행 중 /new 가 들어오면 결과 세션을 버린다 (commitSid 참고)
    // permissionMode 를 넘기지 않아 cfg.permissionMode 로 돈다 — 승인 실행은 plan 고정을 무시해야
    // 한다. 여기서 고정을 따르면 승인한 계획을 또 계획하고 앉아 있게 된다.
    const res = await runClaude(PLAN_PROCEED_PROMPT, pending.sessionId, { modelHint: true, trackChild: r, injectMemory: true, chatId });
    if (res.sessionId) commitSid(r, gen, chatId, res.sessionId, "claude");
    await replyWithClaudeResult(chatId, l, PLAN_PROCEED_PROMPT, syntheticMsg, res, started, false, gen);
  } catch (e) {
    if (!r.stopping) await send(chatId, t(l, "botError", e.message));
  } finally {
    clearInterval(r.typing);
    r.typing = null;
    r.stopping = false;
    r.busy = false;
    if (r.queue.length > 0 && !roomRateLimited(chatId)) setImmediate(() => handle(drainQueue(chatId)));
  }
}

// 처리한 인라인 키보드를 기억한다 — 버튼 제거(editMessageReplyMarkup)는 텔레그램 왕복이라
// 그 사이에 다른 버튼을 또 누를 수 있다. 압축처럼 오래 걸리는 동작에서 실제로 "압축했습니다"와
// "나중에 묻겠습니다"가 같이 뜨는 일이 있었다. 한 키보드당 한 번만 처리한다.
const handledKeyboards = new Set();
const HANDLED_KEYBOARD_MEMORY = 200;

// 텔레그램 인라인 버튼(✅/❌) 클릭 처리
async function handleCallback(cq) {
  const rawChatId = cq.message?.chat?.id;
  const chatId = roomOf(cq.message); // 버튼도 눌린 토픽의 방에서 처리한다
  if (!rawChatId || !allowedIds.includes(String(rawChatId))) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
    return;
  }
  // 세션 목록은 확인 버튼이 아니라 메뉴다 — 하나 골랐다고 끝이 아니라 되돌아가서 또 고른다.
  // 그래서 1회용 잠금과 버튼 제거에서 빼둔다. 세션 전환은 몇 번을 눌러도 결과가 같아 안전하다.
  const menu = cq.data?.startsWith("ss:");
  const kbKey = `${chatId}:${cq.message.message_id}`;
  if (!menu) {
    if (handledKeyboards.has(kbKey)) {
      await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
      return;
    }
    handledKeyboards.add(kbKey);
    if (handledKeyboards.size > HANDLED_KEYBOARD_MEMORY)
      handledKeyboards.delete(handledKeyboards.values().next().value);
  }
  const l = langOf({ from: cq.from });
  await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
  // 중복 클릭 방지 — 원본 메시지의 버튼 제거
  if (!menu) {
    if (liveMenus.get(chatId) === cq.message.message_id) liveMenus.delete(chatId);
    tg("editMessageReplyMarkup", {
      chat_id: rawChatId,
      message_id: cq.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }
  if (cq.data === "plan:yes") {
    runApprovedPlan(chatId, l).catch((e) => console.error("Plan approval error:", e.message));
  } else if (cq.data === "plan:no") {
    pendingPlans.delete(chatId);
    await send(chatId, t(l, "planCancelled"));
    await flushCompactAsk(chatId, l);
  } else if (cq.data?.startsWith("ac:")) {
    await handleAutoCompact(chatId, cq.data.slice(3), l);
  } else if (cq.data?.startsWith("mw:")) {
    await handleMergeWindow(chatId, cq.data.slice(3), l);
  } else if (cq.data === "cp:yes") {
    await runCompact(chatId, l, "autoCompact");
  } else if (cq.data?.startsWith("cp:later:")) {
    const n = Number(cq.data.slice(9)) || 0;
    state.autoCompactSnooze = roundTokens(n * AUTOCOMPACT_SNOOZE_RATIO);
    saveState(state);
    await send(chatId, t(l, "autoCompactLater", state.autoCompactSnooze));
  } else if (cq.data?.startsWith("pv:")) {
    await handleProvider(chatId, cq.data.slice(3), l);
  } else if (cq.data?.startsWith("pl:")) {
    await handlePlanLock(chatId, cq.data.slice(3), l);
  } else if (cq.data?.startsWith("md:")) {
    const sep = cq.data.indexOf(":", 3);
    await handleModel(chatId, cq.data.slice(sep + 1), l, cq.data.slice(3, sep));
  } else if (cq.data?.startsWith("ss:")) {
    const sep = cq.data.indexOf(":", 3);
    await handleSessions(chatId, cq.data.slice(sep + 1), l, cq.data.slice(3, sep), cq.message.message_id);
  } else if (cq.data?.startsWith("tl:")) {
    const pending = pendingTells.get(cq.data.slice(5));
    pendingTells.delete(cq.data.slice(5));
    if (!pending) await send(chatId, t(l, "tellExpired"));
    else if (cq.data.startsWith("tl:n:")) await send(chatId, t(l, "tellRejected"));
    else runRelay(pending.from, pending.to, pending.text).catch((e) => console.error("Relay run error:", e.message));
  } else if (cq.data?.startsWith("pa:")) {
    const persona = PERSONAS.find((p) => p.id === cq.data.slice(3));
    // config 에서 사라진 역할의 버튼이 남아 있을 수 있다 — 재시작 전에 띄운 것.
    if (!persona) await send(chatId, t(l, "personaGone"));
    else await applyPersona(chatId, persona, l);
  } else if (cq.data === "local:kill") {
    await handleLocal(chatId, "kill", l);
  }
}

async function handle(msg) {
  if (!msg.chat?.id) return;
  const chatId = roomOf(msg); // 포럼 그룹이면 토픽까지가 방이다 — 아래 chatId 는 전부 방 키
  const rawChatId = baseChatId(chatId); // 화이트리스트·리액션용 실제 채팅 ID
  const l = langOf(msg);
  const text = normalizeDashFlags(stripBotMention((msg.text || msg.caption || "").trim()));
  const attachment = msg._mediaGroup ? null : pickAttachment(msg);
  // 주제 생성·이름 변경 서비스 메시지는 본문이 없지만 토픽 이름이 실려 오는 유일한 통로다.
  // 이름만 적어두려고 여기서 막지 않고 화이트리스트 검사까지 통과시킨다.
  const topicName = msg.forum_topic_created?.name || msg.forum_topic_edited?.name;
  if (!text && !attachment && !msg._mediaGroup?.length && !topicName) return;

  // 화이트리스트
  if (!allowedIds.length) {
    await send(chatId, t(l, "needChatId", rawChatId));
    return;
  }
  if (!allowedIds.includes(String(rawChatId))) {
    console.warn(`Ignoring unauthorized chatId ${rawChatId}`);
    // 명령은 실행하지 않는다 — 넣어야 할 chatId 만 한 번 알려주고 끝이다.
    await greetUnknownRoom(chatId, rawChatId, msg.from, l);
    return;
  }
  // 입력중 표시를 General 토픽에 제대로 띄우려면 이 방이 포럼인지 알아야 한다 — typingTarget() 참고.
  if (msg.chat?.is_forum) rememberForum(rawChatId);
  // 서비스 메시지는 이 방의 이름만 챙기고 끝난다. 생성 서비스 메시지에 is_topic_message 가
  // 붙는지는 보장이 없어서, 이 경로에서만 message_thread_id 로 방 키를 직접 만든다.
  const room = roomTitleOf(msg, topicName);
  rememberRoomTitle(
    topicName ? roomKey(rawChatId, msg.message_thread_id) : chatId,
    room.title,
    room.weak,
  );
  if (topicName) return;
  // 혼잣말 — `//` 로 시작하는 메시지는 봇이 무시한다. 작업 중 떠오른 딴 주제 메모를
  // 세션에 넣지 않고 채팅에 남겨두는 용도. 👀 리액션으로 "봤고, 무시했다"만 알린다.
  // `/*` 는 그 블록 버전 — `*/` 로 시작하는 메시지가 올 때까지 이 방의 모든 입력을 무시한다.
  // 로그를 붙여넣거나 메모를 연달아 남길 때 매번 `//` 를 붙이지 않아도 된다. 닫는 걸 잊으면
  // 봇이 죽은 것처럼 보이는 게 유일한 함정이라, 들어갈 때 탈출 방법을 알리고 무시할 때마다
  // 👀 를 남긴다 — 눈 아이콘만 계속 달리면 아직 주석 모드라는 게 바로 보인다.
  const seen = () =>
    tg("setMessageReaction", {
      chat_id: rawChatId,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "👀" }],
    }).catch(() => {});
  if (chatBucket(chatId).muted) {
    seen();
    if (text.startsWith("*/")) {
      chatBucket(chatId).muted = undefined;
      saveState(state);
      await send(chatId, t(l, "muteOff"));
    }
    return;
  }
  if (text.startsWith("//")) {
    seen();
    return;
  }
  // 처음 보는 방의 첫 대화 — 역할 버튼을 띄우되 **답은 그냥 진행한다.** 폰에서 급히 물었는데
  // 버튼부터 나오고 답이 안 오면 마찰이 크다. 안 고르면 기본 역할로 돈다.
  // 한 방에 한 번만 묻는다(personaAsked). 버튼은 첫 턴이 시작되면 저절로 무효가 된다 —
  // personaChangeable() 이 세션·실행 중을 다시 보기 때문이다. → docs/design/room-personas.md
  if (PERSONAS.length && !text.startsWith("/")) {
    const b = chatBucket(chatId);
    if (!b.persona && !b.personaAsked && personaChangeable(chatId)) {
      b.personaAsked = true;
      saveState(state);
      await sendPersonaMenu(chatId, l, "personaFirst");
    }
  }
  if (text.startsWith("/*")) {
    seen();
    // 한 메시지 안에서 열고 닫으면(`/* 메모 */`) 블록에 들어가지 않고 1회성 무시로 끝낸다.
    if (!text.slice(2).includes("*/")) {
      chatBucket(chatId).muted = true;
      saveState(state);
      await send(chatId, t(l, "muteOn"));
    }
    return;
  }
  // 대화가 이어졌으니 이전 설정 메뉴는 낡았다 — 위로 밀려 올라간 버튼을 먼저 걷어낸다.
  // 주석(`//`·`/* */`)으로 무시한 입력은 대화가 아니라 메모라 여기까지 오지 않는다.
  dropLiveMenu(chatId);
  const r = rt(chatId); // 이 방의 실행 상태 (busy·child·typing·queue…)

  // 레이트리밋 활성 중: 일반 메시지는 큐에 추가, 명령어는 통과
  if (roomRateLimited(chatId) && !text.startsWith("/")) {
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
    // 화이트리스트에 넣을 값은 채팅 ID다 — 토픽은 방 구분용이라 참고로만 덧붙인다.
    const topic = msg.is_topic_message ? `\ntopic: ${msg.message_thread_id}` : "";
    await send(chatId, `chatId: ${rawChatId}${topic}`);
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
        provider: currentProvider(chatId),
        cliVersions,
        name: cfg.name || "claude-telegram-bot",
        // 페르소나를 안 쓰는 봇에는 줄 자체가 안 붙는다 — /status 는 이미 길다.
        persona: roomPersona(chatId)?.name,
        model: currentModel(chatId) || (currentProvider(chatId) === "codex" ? cfg.codexModel : cfg.model)
          || (l === "ko" ? "(기본값)" : "(default)"),
        fallback: currentProvider(chatId) === "codex"
          ? (cfg.ollamaFallback ? "Ollama" : (l === "ko" ? "꺼짐" : "off"))
          : cfg.codexFallback
            ? `Codex${getSid(chatId, "codex") ? (l === "ko" ? " (세션 있음)" : " (session active)") : ""}`
            : cfg.ollamaFallback
              ? "Ollama"
              : (l === "ko" ? "꺼짐" : "off"),
        hasSession: Boolean(getSid(chatId)),
        jobs: schedule.length,
        projectDir: cfg.projectDir,
        // plan 고정 중이면 지금 실제로 쓰이는 값이 plan 이다 — 설정값만 보여주면 왜 파일이
        // 안 바뀌는지 알 길이 없다. Codex 방에서는 고정이 놀고 있다는 것도 여기서 드러나야 한다.
        permissionMode: !planLocked(chatId)
          ? cfg.permissionMode || "acceptEdits"
          : currentProvider(chatId) === "claude"
            ? `plan 🔒 → ${cfg.permissionMode || "acceptEdits"}`
            : `${cfg.permissionMode || "acceptEdits"} (plan 🔒 ${l === "ko" ? "Codex 미적용" : "not applied to Codex"})`,
      }),
    );
    return;
  }
  if (text === "/provider" || text.startsWith("/provider ")) {
    await handleProvider(chatId, text.slice(9).trim().toLowerCase(), l);
    return;
  }
  // `/plan on|off` 와 인자 없는 `/plan` 은 방 설정이라 여기서 즉시 답한다. 실제 요청이 붙은
  // `/plan <요청>` 만 아래 실행 경로로 내려간다 — 그쪽은 세션을 돌려야 해서 busy 락이 필요하다.
  const planArg = text === "/plan" ? "" : text.startsWith("/plan ") ? text.slice(5).trim().toLowerCase() : null;
  if (planArg === "" || planArg === "on" || planArg === "off") {
    await handlePlanLock(chatId, planArg, l);
    return;
  }
  if (text === "/model" || text.startsWith("/model ")) {
    await handleModel(chatId, text.slice(6).trim(), l);
    return;
  }
  if (text === "/sessions" || text.startsWith("/sessions ")) {
    await handleSessions(chatId, text.slice(9).trim(), l);
    return;
  }
  if (text === "/name" || text.startsWith("/name ")) {
    await handleName(chatId, text.slice(5).trim(), l);
    return;
  }
  if (text === "/jobs") {
    await handleJobs(chatId, l);
    return;
  }
  if (text === "/persona") {
    await handlePersona(chatId, l);
    return;
  }
  if (text === "/tell" || text.startsWith("/tell ")) {
    await handleTell(chatId, text.slice(5).trim(), l);
    return;
  }
  if (text === "/autocompact" || text.startsWith("/autocompact ")) {
    await handleAutoCompact(chatId, text.slice(13).trim(), l);
    return;
  }
  if (text === "/mergewindow" || text.startsWith("/mergewindow ")) {
    await handleMergeWindow(chatId, text.slice(13).trim(), l);
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
      const testGen = r.gen;
      const res = cfg.codexFallback
        ? await runCodex(prompt, l, { trackChild: r, recordHandoff: false, sessionId: getSid(chatId, "codex"), chatId })
        : await runOllama(prompt, l, { chatId });
      if (res.ok) {
        if (cfg.codexFallback && res.sessionId) commitSid(r, testGen, chatId, res.sessionId, "codex");
        await send(chatId, res.text);
      }
      else await send(chatId, t(l, "testFallbackFail", res.text));
    } catch (e) {
      await send(chatId, t(l, "testFallbackFail", e.message));
    }
    return;
  }
  // 텔레그램 용어로는 '주제(topic)', 체감으로는 '새 대화방' — 어느 쪽을 칠지 갈려서 둘 다 받는다.
  const newTopicCmd = text.match(/^\/(?:newchat|newtopic)(?:\s|$)/) || text.match(/^\/new --chat(?:\s|$)/);
  if (newTopicCmd) {
    await newTopic(chatId, text.slice(newTopicCmd[0].length).trim(), l);
    return;
  }
  if (text === "/new") {
    // 돌고 있는 실행이 끝나며 후속 세션을 등록하지 못하게 막는다(commitSid 참고).
    r.gen++;
    // 양쪽 provider 를 다 지운다. 현재 것만 지우면 살아남은 Codex 세션을 다음 폴백이 그대로
    // 이어받아(replyWithClaudeResult 의 `getSid(chatId, "codex")`), 맥락을 비웠다고 안내해 놓고
    // 폴백만 옛 대화를 기억하는 상태가 된다. 다른 방 세션은 그대로다.
    setSid(chatId, undefined, "claude");
    setSid(chatId, undefined, "codex");
    state.autoCompactSnooze = undefined; // 컨텍스트가 비었으니 미뤄둔 것도 의미 없음
    r.compactAsk = 0; // 승인 대기 때문에 미뤄둔 물음도 같이 — 물어볼 컨텍스트 자체가 사라졌다
    saveState(state);
    await send(chatId, t(l, "newSession"));
    // 맥락을 버린 자리 = 역할을 고를 수 있는 자리. 여기서 안 물으면 사람이 /persona 를 따로
    // 쳐야 하는데, 그건 이 기능이 있는 줄 아는 사람만 하게 된다.
    await sendPersonaMenu(chatId, l, "personaPick");
    return;
  }
  if (text === "/local" || text.startsWith("/local ")) {
    await handleLocal(chatId, text.slice(6).trim().toLowerCase(), l);
    return;
  }
  if (text === "/stop" || text.startsWith("/stop ")) {
    // 아직 시작 안 한 병합 창을 물고 있을 수 있다 — 안 치우면 "작업해줘" → /stop 직후에 그 작업이
    // 그대로 시작된다. 아직 프로세스를 띄운 게 없으니 죽일 자식도, 되돌릴 세션도 없다.
    if (!r.busy && cancelHold(chatId)) {
      r.queue.length = 0;
      clearHeld(chatId);
      await send(chatId, t(l, "stopOk"));
      return;
    }
    if (!r.busy || !r.child) {
      // 봇 작업은 없어도 로컬 ctb 가 물고 있을 수 있다 — 종료 버튼을 같이 준다.
      const info = localLockInfo();
      if (info) {
        await send(chatId, t(l, "localActive", info.pid, info.mins, info.where), { replyMarkup: localKillMarkup(l) });
        return;
      }
      await send(chatId, t(l, "stopNoop"));
      return;
    }
    const reset = text.includes("--reset");
    r.stopping = true;
    r.queue.length = 0; // 이 방의 대기 메시지도 취소 (다른 방은 그대로)
    clearHeld(chatId);
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
    const existing = loadMemory(chatId);
    const updated = existing ? `${existing}\n- ${content}` : `- ${content}`;
    saveMemory(chatId, updated);
    const n = memoryItems(updated).length;
    await send(chatId, n > MEMORY_CROWDED ? `${t(l, "remembered")}\n\n${t(l, "memoryCrowded", n)}` : t(l, "remembered"));
    return;
  }
  if (text === "/memory" || text.startsWith("/memory ")) {
    const arg = text.slice(7).trim();
    if (arg === "clear") {
      saveMemory(chatId, "");
      await send(chatId, t(l, "memoryCleared"));
      return;
    }
    const items = memoryItems(loadMemory(chatId));
    if (arg === "rm" || arg.startsWith("rm ")) {
      if (!items.length) { await send(chatId, t(l, "memoryEmpty")); return; }
      // `rm 3` · `rm 3 5 7` · `rm 3-9` — 섞어 써도 된다. 정리는 몰아서 하게 되는 일이라
      // 하나씩 지우면 번호가 매번 밀려서 목록을 다시 봐야 한다.
      // 하나라도 범위를 벗어나면 통째로 거절한다 — 일부만 지우고 나면 남은 번호가 어긋나서
      // 이어 친 명령이 엉뚱한 규칙을 지운다.
      const picked = new Set();
      let bad = false;
      for (const tok of arg.slice(2).split(/[\s,]+/).filter(Boolean)) {
        const m = tok.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) { bad = true; break; }
        const from = Number(m[1]);
        // 범위의 끝은 "여기까지"라는 뜻이라 목록 끝으로 줄여서 받는다 — 7개인데 `3-9` 를 쳤으면
        // 3번부터 끝까지 지우려는 것이지 오타가 아니다(`sed -n '3,9p'` 도 같게 동작한다).
        // 단건 번호(`rm 9`)는 그대로 거절한다 — 그건 없는 걸 콕 집은 거라 의도를 짐작할 수 없다.
        // 시작이 목록 밖이면(`9-12`) from > to 가 되어 아래에서 걸린다.
        const to = m[2] === undefined ? from : Math.min(Number(m[2]), items.length);
        if (from < 1 || to > items.length || from > to) { bad = true; break; }
        for (let i = from; i <= to; i++) picked.add(i);
      }
      if (bad || !picked.size) { await send(chatId, t(l, "memoryUsage", items.length)); return; }
      const removed = items.filter((_, i) => picked.has(i + 1));
      saveMemoryItems(chatId, items.filter((_, i) => !picked.has(i + 1)));
      await send(chatId, t(l, "memoryRemoved", removed.join("\n"), removed.length));
      return;
    }
    if (arg) { await send(chatId, t(l, "memoryUsage", items.length)); return; }
    await send(chatId, items.length ? t(l, "memoryShow", memoryNumbered(items)) : t(l, "memoryEmpty"));
    return;
  }
  if (text === "/reserve" || text.startsWith("/reserve ")) {
    const arg = text.slice(8).trim();
    if (arg === "rm") {
      if (!rateLimitUntil && !rateLimitTimer) { await send(chatId, t(l, "reserveNone")); return; }
      if (rateLimitTimer) { clearTimeout(rateLimitTimer); rateLimitTimer = null; }
      rateLimitUntil = null;
      // 모든 방의 예약 대기열 취소 — 열려 있는 병합 창과 그 디스크 사본까지 같이 걷어낸다
      for (const [id, rr] of chatRuntime) { cancelHold(id); rr.queue.length = 0; clearHeld(id); }
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
  if (checkLocalLock(chatId)) {
    await send(chatId, t(l, "localBusy"), { replyMarkup: localKillMarkup(l) });
    return;
  }
  // 여기까지 왔다는 건 지금 당장 실행될 프롬프트라는 뜻이다 — 명령어는 위에서 전부 처리돼 이미
  // 돌아갔고(그래서 /status·/stop 은 창과 무관하게 즉시 응답한다), 바쁘거나 락이 걸린 경우도
  // 각자의 안내를 받고 빠졌다. 그러니 여기서만 잠깐 붙잡으면 뒤따라올 말과 합칠 수 있다.
  if (mergeWindowMs() > 0 && !msg._drained) {
    holdForMore(chatId, msg);
    return;
  }
  r.busy = true;
  const started = Date.now();
  // 긴 작업 동안 타이핑 표시 유지
  r.typing = setInterval(
    () =>
      tg("sendChatAction", { ...typingTarget(chatId), action: "typing" }).catch(
        () => {},
      ),
    TYPING_TICK_MS,
  );

  try {
    await tg("sendChatAction", { ...typingTarget(chatId), action: "typing" });
    // /plan <요청> — permission-mode를 강제로 plan으로 실행해 편집 없이 계획만 받고,
    // 승인 버튼을 눌러야 실제 permissionMode로 이어서 실행 (runApprovedPlan).
    // 여기 오는 건 요청이 붙은 `/plan <요청>` 뿐이다 — 인자 없는 `/plan` 과 `on`/`off` 는
    // 위 명령어 구간에서 handlePlanLock 이 이미 가져갔다.
    if (text.startsWith("/plan ")) {
      if (currentProvider(chatId) !== "claude") { await send(chatId, t(l, "planProviderUnsupported")); return; }
      const planReq = text.slice(5).trim();
      r.prevSession = { chatId: String(chatId), provider: "claude", sessionId: getSid(chatId, "claude") };
      const planGen = r.gen;
      const res = await runClaude(planReq, getSid(chatId, "claude"), { permissionMode: "plan", modelHint: true, trackChild: r, injectMemory: true, chatId });
      if (res.sessionId) commitSid(r, planGen, chatId, res.sessionId, "claude");
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
    let attachFailed = false;
    if (msg._mediaGroup?.length) {
      const notes = [];
      for (const fileId of msg._mediaGroup) {
        try {
          const { dest, name } = await downloadAttachment({ fileId, name: null });
          notes.push(`[Attachment] Absolute path: ${dest} (filename: ${name}). Open it with the Read tool if needed.`);
        } catch (e) {
          attachFailed = true;
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
        attachFailed = true;
        await send(chatId, t(l, "attachFail", e.message));
      }
    }
    // 첨부만 보냈는데 다운로드가 실패하면 남는 게 없다. 여기서 멈추지 않으면 아래 buildMsgMeta 가
    // `[From: ...]` 한 줄을 붙여 prompt 이 non-empty 가 되고, 내용 없는 프롬프트로 세션이 돌아간다.
    if (attachFailed) {
      if (!prompt) return;
      prompt += "\n\n[Attachment] Download failed — the file the user sent is not available.";
    }
    const meta = buildMsgMeta(msg);
    if (meta) prompt = prompt ? `${meta}\n\n${prompt}` : meta;
    if (state.ollamaMode) {
      try {
        const ollamaGen = r.gen;
        const oRes = await runOllama(prompt, l, { noHeader: true, sessionId: getSid(chatId, "claude"), chatId });
        if (oRes.ok) {
          if (oRes.sessionId) commitSid(r, ollamaGen, chatId, oRes.sessionId, "claude");
          await send(chatId, oRes.text);
        }
        else await send(chatId, t(l, "testFallbackFail", oRes.text));
      } catch (e) {
        await send(chatId, t(l, "testFallbackFail", e.message));
      }
      return;
    }
    r.prevSession = { chatId: String(chatId), provider: currentProvider(chatId), sessionId: getSid(chatId) }; // /stop --reset 복원 대상 저장
    // plan 고정 중이면 `/plan <요청>` 을 매번 붙인 것과 같게 돈다. Codex 에는 plan 이 없으므로
    // provider 가 claude 일 때만 걸린다 — /provider 로 바꿔도 고정 자체는 남아 돌아오면 다시 적용된다.
    const planMode = planLocked(chatId) && currentProvider(chatId) === "claude" && !msg._approvedPlan;
    const gen = r.gen; // 실행 중 /new 가 들어오면 결과 세션을 버린다 (commitSid 참고)
    const res = await runPrimary(prompt, {
      sessionId: getSid(chatId),
      lang: l,
      modelHint: true,
      trackChild: r,
      injectMemory: true,
      chatId,
      ...(planMode ? { permissionMode: "plan" } : {}),
    });
    if (res.sessionId) commitSid(r, gen, chatId, res.sessionId);
    await replyWithClaudeResult(chatId, l, prompt, msg, res, started, planMode && res.ok, gen);
    // 계획 본문은 위에서 이미 나갔다 — 승인 버튼만 따로 한 줄 붙인다. 실패했거나 폴백된 답에는
    // 승인할 계획이 없으므로 res.ok 일 때만이다. 버튼은 `/plan <요청>` 과 같은 콜백을 재사용한다.
    if (planMode && res.ok) {
      const messageId = await send(chatId, t(l, "planLockAsk"), {
        replyMarkup: {
          inline_keyboard: [[
            { text: t(l, "planApprove"), callback_data: "plan:yes" },
            { text: t(l, "planCancel"), callback_data: "plan:no" },
          ]],
        },
      });
      pendingPlans.set(chatId, { sessionId: getSid(chatId, "claude"), messageId });
    }
  } catch (e) {
    if (!r.stopping) await send(chatId, t(l, "botError", e.message));
  } finally {
    clearInterval(r.typing);
    r.typing = null;
    r.stopping = false;
    r.busy = false;
    if (r.queue.length > 0 && !roomRateLimited(chatId)) setImmediate(() => handle(drainQueue(chatId)));
  }
}

// 한 방(chat)의 대기열 전체를 꺼내 하나로 합침. 여러 개면 번호+경과시간 붙여 병합.
// 큐가 방별로 분리돼 있어 이 안의 메시지는 모두 같은 방·같은 세션 → 안전하게 병합 가능.
// 여기서 나온 메시지는 handle() 로 되돌아가므로 `_drained` 를 찍어 둔다 — 표시가 없으면 병합 창에
// 또 붙잡혀 영영 실행되지 않는다. 작업이 끝난 뒤 드레인되는 메시지도 이미 충분히 기다렸으니 마찬가지다.
function drainQueue(chatId) {
  const group = rt(chatId).queue.splice(0);
  clearHeld(chatId); // 큐를 비우는 유일한 자리 — 창이 남긴 디스크 사본도 여기서 같이 지운다
  if (group.length === 1) return Object.assign(group[0].msg, { _drained: true });
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
    // 전부 승인 실행이어야 plan 고정을 건너뛴다. 사용자 입력이 섞였으면 그건 아직 승인 안 된
    // 요청이라 계획부터 세우는 게 맞다 — 승인 버튼을 다시 누르면 그때는 곧장 실행된다.
    _approvedPlan: group.every((item) => item.msg._approvedPlan) || undefined,
    // 하나라도 옆방에서 전달된 거면 합쳐진 턴 전체를 전달로 본다 — 되전달을 막는 쪽이 안전하다.
    _relay: group.find((item) => item.msg._relay)?.msg._relay,
    _drained: true,
  };
}

// ── 연속 메시지 합치기 ────────────────────────────────────────────────────
// 첫 메시지가 왔다고 바로 provider 를 띄우지 않고 잠깐 창을 열어 둔다. 그 사이 더 오면 창을 다시 열고,
// 조용해지면 drainQueue() 로 한 덩어리를 만들어 한 번만 실행한다. 붙잡아 두는 곳이 별도 버퍼가 아니라
// 기존 방 대기열(r.queue)인 게 요점이다 — /stop·/restart·/reserve 가 이미 그 큐를 보고 있어서
// "대기 중인 메시지"를 세는 자리가 하나로 유지된다.
const holdTimers = new Map(); // 방 키 → { timer, firstAt }

// 붙잡아 둔 메시지는 메모리에만 있어서 재시작·크래시에 통째로 사라진다. 대기열에 밀린 메시지와 달리
// `⏳` 안내조차 나가지 않은 상태라 보낸 사람은 답을 기다리고 있고, 텔레그램 Bot API 에는 지난 메시지를
// 되가져올 수단이 없다 — getUpdates 는 아직 안 가져간 업데이트만, 그것도 한 번만 준다. 여기서 흘리면
// 복구할 방법 자체가 없다는 뜻이라, 창이 열려 있는 동안만 state 에 적어 두고 부팅 때 이어 실행한다.
function saveHeld(chatId) {
  const q = rt(chatId).queue;
  if (!q.length) return clearHeld(chatId);
  (state.held ??= {})[chatId] = q.map(({ msg, receivedAt }) => ({ msg, receivedAt }));
  saveState(state);
}
function clearHeld(chatId) {
  if (!state.held?.[chatId]) return;
  delete state.held[chatId];
  if (!Object.keys(state.held).length) state.held = undefined;
  saveState(state);
}
// 죽기 전에 창이 물고 있던 메시지를 부팅 직후 이어서 실행한다. 창은 이미 충분히(재시작 시간만큼)
// 기다렸으므로 다시 열지 않고 바로 드레인한다.
function resumeHeld() {
  const held = state.held;
  if (!held) return;
  state.held = undefined;
  saveState(state);
  for (const [chatId, items] of Object.entries(held)) {
    if (!items?.length) continue;
    console.log(`Resuming ${items.length} held message(s) for ${chatId}`);
    rt(chatId).queue.push(...items);
    setImmediate(() => handle(drainQueue(chatId)).catch((e) => console.error("Handle error:", e.message)));
  }
}

function holdForMore(chatId, msg) {
  const r = rt(chatId);
  r.queue.push({ msg, receivedAt: Date.now() });
  saveHeld(chatId);
  const held = holdTimers.get(chatId);
  if (held) clearTimeout(held.timer);
  // 첫 메시지에만 타이핑 표시를 한 번 띄운다 — 창이 열린 동안의 침묵이 "봇이 죽었나"로 보이면 안 된다.
  else tg("sendChatAction", { ...typingTarget(chatId), action: "typing" }).catch(() => {});
  const firstAt = held?.firstAt ?? Date.now();
  // 말이 계속 이어지면 창이 무한정 밀린다 — 여럿이 떠드는 그룹에서 특히. 첫 메시지 기준 상한을 둔다.
  // 상한도 창에 비례하므로, 잘린 조각을 기다리는 동안에는 상한도 같이 늘어난다.
  const win = looksSplit(msg) ? Math.max(mergeWindowMs(), SPLIT_WINDOW_MS) : mergeWindowMs();
  const wait = Math.max(0, Math.min(win, firstAt + win * MERGE_HOLD_RATIO - Date.now()));
  const timer = setTimeout(() => {
    holdTimers.delete(chatId);
    if (!r.queue.length) return; // /stop 등이 이미 치웠다
    // 리밋 해제 때 예약 큐가 통째로 드레인되므로 큐는 그대로 둔다. 다만 창에 붙잡힌 메시지는 대기
    // 안내를 한 번도 못 받았다 — 여기서 알리지 않으면 보낸 사람 눈에는 그냥 무시당한 걸로 보인다.
    if (roomRateLimited(chatId)) {
      const l = langOf(msg);
      const timeStr = rateLimitUntil.toLocaleTimeString(l === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
      send(chatId, t(l, "rateLimitQueued", r.queue.length, timeStr)).catch(() => {});
      return;
    }
    handle(drainQueue(chatId)).catch((e) => console.error("Handle error:", e.message));
  }, wait);
  holdTimers.set(chatId, { timer, firstAt });
}

// /stop 이나 재시작이 대기 중인 창을 취소할 때. 취소했으면 true.
function cancelHold(chatId) {
  const held = holdTimers.get(chatId);
  if (!held) return false;
  clearTimeout(held.timer);
  holdTimers.delete(chatId);
  return true;
}

// 미디어 그룹(여러 장 동시 전송) — 1초 대기 후 일괄 처리
function mergeMediaGroup(msgs) {
  const captions = msgs.map((m) => m.caption || "").filter(Boolean);
  const fileIds = msgs
    .filter((m) => m.photo?.length)
    .map((m) => m.photo[m.photo.length - 1].file_id);
  return { ...msgs[0], text: captions.join("\n"), caption: undefined, _mediaGroup: fileIds };
}

// 일반 그룹에서 '주제(Topics)'를 켜거나 관리자가 슈퍼그룹으로 올리면 텔레그램이 그 방에 채팅 ID 를
// 새로 발급한다(`-100…` 접두사). 그러면 allowedChatId 에 적힌 옛 ID 는 죽은 값이 되고, 봇은 새 방의
// 메시지를 전부 "모르는 방"이라며 조용히 버린다 — 쓰는 사람 눈에는 봇이 죽은 것과 구분이 안 된다.
// 승격 순간 텔레그램이 옛 방에는 migrate_to_chat_id 를, 새 방에는 migrate_from_chat_id 를 한 번씩
// 보내주므로, 옛 ID 가 허용된 방이었을 때만 새 ID 를 물려받고 세션도 새 키로 옮긴다.
// (허용된 방에서 출발한 승격만 따라가므로 아무 그룹이나 스스로 화이트리스트에 들어올 수는 없다.)
async function adoptMigratedChat(msg) {
  const [from, to] = msg.migrate_to_chat_id
    ? [String(msg.chat.id), String(msg.migrate_to_chat_id)]
    : [String(msg.migrate_from_chat_id), String(msg.chat.id)];
  if (!allowedIds.includes(from) || allowedIds.includes(to)) return;
  allowedIds.push(to);
  state.adoptedChatIds = [...(state.adoptedChatIds || []), to];
  // 방 키가 통째로 바뀌므로 세션·대기열도 옮긴다 — 안 그러면 승격과 동시에 맥락이 사라진다.
  for (const k of Object.keys(state.sessions || {})) {
    if (k !== from && !k.startsWith(`${from}:`)) continue;
    state.sessions[to + k.slice(from.length)] = state.sessions[k];
    delete state.sessions[k];
  }
  saveState(state);
  console.warn(`Chat migrated: ${from} → ${to} (adopted)`);
  await send(to, t(BOT_LANG, "chatMigrated", from, to)).catch(() => {});
}

function dispatch(msg) {
  if (msg.migrate_to_chat_id || msg.migrate_from_chat_id) {
    adoptMigratedChat(msg).catch((e) => console.error("Migration error:", e.message));
    return;
  }
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
  // 죽기 전에 병합 창이 물고 있던 메시지가 있으면 지금 이어서 실행. botUsername 이 채워진 뒤라야
  // 그룹에서 온 `/cmd@BotName` 이 제대로 벗겨진다.
  resumeHeld();

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

  // 받을 업데이트 종류를 명시한다. 텔레그램은 allowed_updates 를 생략하면 '직전에 지정한 값'을 계속
  // 쓰므로, 같은 토큰을 예전에 다른 도구가 좁혀 놨으면 my_chat_member 가 조용히 안 오고 초대 안내가
  // 통째로 사라진다. 여기 적힌 셋이 이 봇이 처리하는 전부다 — 핸들러를 늘리면 이 목록도 같이 늘린다.
  const UPDATES = ["message", "callback_query", "my_chat_member"];

  // 시작 시 밀린 메시지 건너뛰기
  let offset = 0;
  try {
    const init = await tg("getUpdates", { timeout: 0, offset: -1, allowed_updates: UPDATES });
    if (init.ok && init.result.length)
      offset = init.result[init.result.length - 1].update_id + 1;
  } catch {}

  startScheduler();
  startJobWatcher();
  checkForUpdate().catch(() => {});

  while (true) {
    try {
      const res = await tg("getUpdates", { offset, timeout: 30, allowed_updates: UPDATES });
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      for (const upd of res.result) {
        offset = upd.update_id + 1;
        if (upd.message) dispatch(upd.message);
        else if (upd.callback_query) handleCallback(upd.callback_query).catch((e) => console.error("Callback error:", e.message));
        else if (upd.my_chat_member) handleMyChatMember(upd.my_chat_member).catch((e) => console.error("Membership error:", e.message));
      }
    } catch (e) {
      console.error("Polling error:", e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main();
