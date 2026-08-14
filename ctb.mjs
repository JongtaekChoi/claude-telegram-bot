#!/usr/bin/env node
// ctb — short-form CLI for claude-telegram-bot
//
// ctb [config.json] [--provider claude|codex] [--chat <id>] [...provider args]
//                                      Resume the provider's Telegram session
//                                      (--chat picks the room; default is allowedChatId[0])
// ctb bot [config.json]                Start the Telegram bot daemon (delegates to bot.mjs)
// ctb init [dir]                       Create a config.json template
// ctb --help | --version
//
// config.json is optional. A bare name like "planner.json" resolves relative to the
// package directory (where bot configs typically live alongside bot.mjs).
// Absolute or explicitly relative paths (/ or ./) resolve as-is.
//
// While a provider runs, .claude-bot/local.lock (PID) is created so the bot defers
// incoming Telegram messages until the local session ends.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import dns from "node:dns";
import net from "node:net";

dns.setDefaultResultOrder("ipv4first");
if (net.setDefaultAutoSelectFamily) net.setDefaultAutoSelectFamily(false);

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const a = args[0];

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version;
  } catch {
    return "?";
  }
})();;

function runBot(botArgs) {
  const child = spawn(process.execPath, [join(HERE, "bot.mjs"), ...botArgs], {
    stdio: "inherit",
  });
  child.on("close", (code) => process.exit(code ?? 0));
}

function resolveConfig(arg) {
  if (!arg) {
    if (process.env.BOT_CONFIG) return process.env.BOT_CONFIG;
    // cwd 우선(프로젝트 폴더에서 ctb 실행) → 전역 설치 경로 폴백
    for (const base of [process.cwd(), HERE]) {
      for (const name of ["mybot.json", "config.json"]) {
        const p = join(base, name);
        if (existsSync(p)) return p;
      }
    }
    return join(process.cwd(), "mybot.json"); // 최종 폴백
  }
  // Absolute or explicitly relative path → use as-is
  if (arg.startsWith("/") || arg.startsWith("./") || arg.startsWith("../"))
    return arg;
  // Bare name (e.g. "planner.json") → relative to cwd first, then package dir
  return existsSync(join(process.cwd(), arg)) ? join(process.cwd(), arg) : join(HERE, arg);
}

async function main() {
  if (a === "-h" || a === "--help") {
    console.log(
      `ctb v${VERSION} — claude-telegram-bot short CLI\n\n` +
      `Usage:\n` +
      `  ctb [config.json] [--provider claude|codex] [--chat <id>] [...args]\n` +
      `                                Resume the provider's Telegram session\n` +
      `  ctb bot [config.json]         Start the Telegram bot daemon\n` +
      `  ctb init [dir]                Create a config.json template\n` +
      `  ctb --help | --version\n\n` +
      `config.json defaults to $BOT_CONFIG or the package's own config.json.\n` +
      `A bare name like "planner.json" resolves relative to the package directory.\n\n` +
      `Provider precedence: --provider flag → /provider override in state → config.provider → claude.\n\n` +
      `Examples:\n` +
      `  ctb                           Interactive configured provider, continuing its session\n` +
      `  ctb -p "what did we do?"      Headless configured provider with session context\n` +
      `  ctb planner.json              Resume planner persona session interactively\n` +
      `  ctb planner.json -p "..."     Headless with planner session\n` +
      `  ctb planner.json --provider codex  Interactive Codex with its Telegram session\n` +
      `  ctb --chat -5360343684        Resume that group chat's session instead of the DM\n` +
      `  ctb bot                       Start the bot with default config\n` +
      `  ctb bot planner.json          Start the bot with planner config`,
    );
    process.exit(0);
  }

  if (a === "-v" || a === "--version") {
    console.log(VERSION);
    process.exit(0);
  }

  if (a === "init") {
    runBot(args);
    return;
  }

  if (a === "bot") {
    runBot(args.slice(1));
    return;
  }

  // Run the selected provider, resuming that provider's bot session.
  const looksLikeConfig = a && a.endsWith(".json");
  const configPath = resolveConfig(looksLikeConfig ? a : undefined);
  const providerArgs = looksLikeConfig ? args.slice(1) : args;
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  let providerOverride;
  let chatOverride;
  const forwardedArgs = [];
  for (let i = 0; i < providerArgs.length; i++) {
    const arg = providerArgs[i];
    if (arg === "--provider") {
      providerOverride = providerArgs[++i];
      if (!providerOverride) throw new Error("--provider requires claude or codex");
    } else if (arg.startsWith("--provider=")) {
      providerOverride = arg.slice("--provider=".length);
    } else if (arg === "--chat") {
      chatOverride = providerArgs[++i];
      if (!chatOverride) throw new Error("--chat requires a chat id");
    } else if (arg.startsWith("--chat=")) {
      chatOverride = arg.slice("--chat=".length);
    } else {
      forwardedArgs.push(arg);
    }
  }
  const dataDir = dirname(configPath);
  const botDir = join(dataDir, ".claude-bot");
  const stateBase = basename(configPath, ".json");
  const stateFile = stateBase === "config" ? "state.json" : `${stateBase}.state.json`;
  const statePath = join(botDir, stateFile);
  const lockPath = join(botDir, "local.lock");

  // 봇이 텔레그램에서 /provider 로 전환했을 수 있으니 state.json 의 provider 를
  // cfg.provider 보다 우선한다 (bot.mjs의 currentProvider()와 동일한 우선순위).
  let stateProvider;
  try {
    const p = JSON.parse(readFileSync(statePath, "utf8")).provider;
    if (["claude", "codex"].includes(p)) stateProvider = p;
  } catch {}
  const provider = providerOverride || stateProvider || cfg.provider || "claude";
  if (!["claude", "codex"].includes(provider)) {
    throw new Error(`Unsupported provider: ${provider} (expected claude or codex)`);
  }

  mkdirSync(botDir, { recursive: true });
  writeFileSync(lockPath, String(process.pid));
  const cleanup = () => { try { unlinkSync(lockPath); } catch {} };
  process.on("exit", cleanup);

  // SIGINT/SIGTERM: 종료 코드만 기록하고 exit 하지 않음.
  // claude 도 같은 프로세스 그룹이라 동시에 신호를 받아 종료되고,
  // child.on("close") 가 발화하면서 알림 전송 후 종료함.
  let signalExitCode = null;
  process.on("SIGINT", () => { signalExitCode = 130; });
  process.on("SIGTERM", () => { signalExitCode = 143; });

  // 세션은 방(chatId)별로 state.sessions 아래에 저장된다(bot.mjs의 chatBucket과 동일 구조).
  // 어느 방을 이어받을지는 --chat 으로 지정하고, 없으면 allowedChatId 첫 번째(보통 소유자 DM)를
  // 쓴다 — bot.mjs의 구버전 마이그레이션이 primary 로 고르는 방과 같은 규칙이다.
  // 최상위 키 폴백은 0.4.3 이전 state.json 을 위한 것.
  const sessionKey = provider === "codex" ? "codexSessionId" : "sessionId";
  const primaryChatId = chatOverride
    ? String(chatOverride)
    : [].concat(cfg.allowedChatId).filter(Boolean).map(String)[0];
  let sessionId;
  try {
    const st = JSON.parse(readFileSync(statePath, "utf8"));
    sessionId = (primaryChatId && st.sessions?.[primaryChatId]?.[sessionKey]) || st[sessionKey];
  } catch {}

  if (sessionId) {
    // 어느 방의 세션인지 같이 찍는다 — 방마다 세션이 갈리는데 화면에는 세션 ID 만 떠서,
    // DM 을 이어받았는지 그룹을 이어받았는지 확인할 방법이 없었다.
    process.stderr.write(`Resuming ${provider} session: ${sessionId} (chat ${primaryChatId})\n`);
    if (provider === "claude") {
      // 텔레그램 이전 대화와 구분하기 위해 Claude 세션에 시작 마커 삽입
      await new Promise((resolve) => {
        const marker = spawn(cfg.claudeBin || "claude", [
          "--resume", sessionId, "-p", "---ctb:start---", "--output-format", "json",
        ], { cwd: cfg.projectDir, env: { ...process.env, ...(cfg.env || {}) }, stdio: ["ignore", "ignore", "ignore"] });
        marker.on("close", resolve);
        marker.on("error", resolve);
        setTimeout(() => { marker.kill(); resolve(); }, 15000);
      });
    }
  }

  const bin = provider === "codex" ? (cfg.codexBin || "codex") : (cfg.claudeBin || "claude");
  // persona 와 /remember 규칙은 여기서도 붙인다. --append-system-prompt 는 호출마다 주는 값이라
  // 세션에 저장되지 않는다 — 이어받은 세션은 지난 대화를 흉내내서 persona 가 남은 것처럼 보이지만,
  // /new 직후처럼 이어받을 대화가 없으면 규칙이 통째로 빠진 맨 claude 가 뜬다. 붙일 대상은 설정과
  // 파일에서 그대로 오는 것만 — 텔레그램용 문구(간결하게 답해라, 이미지 전송 규약 등)는 터미널에
  // 해당하지 않아 뺀다. Codex 는 --append-system-prompt 가 없어 대화형에서는 끼워 넣을 자리가 없다.
  const sysArgs = [];
  if (provider === "claude" && !forwardedArgs.includes("--append-system-prompt")) {
    let memory = "";
    try { memory = readFileSync(join(botDir, "memory.md"), "utf8").trim(); } catch {}
    // 메모리를 persona 앞에 두고 헤더를 세게 다는 것까지 bot.mjs 와 같게 — persona 가 덮어쓰지 않게.
    const appendSys = [
      memory ? `## RULES (must follow before anything else)\n${memory}` : null,
      cfg.persona,
    ].filter(Boolean).join("\n\n");
    if (appendSys) sysArgs.push("--append-system-prompt", appendSys);
  }
  // forwardedArgs 는 항상 맨 끝 — `-p <프롬프트>` 로 끝나는 호출에서 순서가 깨지면 안 된다.
  const finalArgs = provider === "codex"
    ? (sessionId ? ["resume", sessionId, ...forwardedArgs] : forwardedArgs)
    : [...(sessionId ? ["--resume", sessionId] : []), ...sysArgs, ...forwardedArgs];
  // CTB_CHAT_ID: 여기서 띄운 백그라운드 작업(.ctb-jobs)이 끝났을 때 봇이 어느 방으로 알릴지.
  // 텔레그램 경로(bot.mjs 의 jobEnv)와 같은 값을 넣어 두 입구가 똑같이 동작하게 한다.
  const child = spawn(bin, finalArgs, {
    cwd: cfg.projectDir,
    env: { ...process.env, ...(cfg.env || {}), ...(primaryChatId ? { CTB_CHAT_ID: primaryChatId } : {}) },
    stdio: "inherit",
  });
  child.on("close", async (code) => {
    cleanup();
    if (sessionId) await notifyTelegram(configPath, provider, sessionId, primaryChatId);
    process.exit(signalExitCode ?? code ?? 0);
  });
  child.on("error", (e) => {
    cleanup();
    process.stderr.write(`ctb: failed to start ${provider}: ${e.message}\n`);
    process.exit(1);
  });
}

// 세션이 끝날 때 텔레그램으로 보낼 한 마디. 예전에는 "무엇을 했는지 10단어로 요약"이었는데,
// 그건 사후 기록이지 인수인계가 아니다. 대화는 끝나는 게 아니라 텔레그램으로 자리를 옮기는
// 것이므로, 남은 사람이 이어받는 데 필요한 걸 물어야 한다 — 끝내지 못한 것, 확인이 필요한 것,
// 주의할 점. 넘길 게 없으면 SKIP 으로 물러서는 건 그대로다(알림이 잡음이 되면 안 읽힌다).
async function summarizeSession(provider, sid, lang, cfg) {
  // `---ctb:` 로 시작하는 건 사람이 친 게 아니라 ctb 가 끼워 넣은 턴이다. 세션 시작 마커도 같은
  // 규칙을 쓰고, bot.mjs 의 /sessions 미리보기가 이 접두사 하나로 둘 다 걸러낸다 — 문구가 바뀔
  // 때마다 저쪽 정규식을 따라 고치던 걸 없애려고 태그로 묶었다.
  const langInstruction = "---ctb:handoff---\n" + (lang && lang.startsWith("ko")
    ? "이 로컬 터미널 세션을 지금 끝내고, 같은 사람과 텔레그램에서 대화를 이어갑니다. 넘길 말이 있으면 알려주세요 — 방금 한 일 중 알아야 할 것, 끝내지 못한 것, 확인이나 결정이 필요한 것, 주의할 점. 한국어로 3줄 이내, 마크다운 없이 텍스트만. 넘길 게 없으면 정확히 이렇게만 답해: SKIP"
    : "This local terminal session is ending now, and the conversation continues with the same person on Telegram. If there is anything to hand over, say it — what was done that they need to know, what is unfinished, what needs a check or a decision, anything to watch out for. 3 lines max, plain text, no markdown. If there is nothing to hand over, reply exactly: SKIP");
  // 결과는 세 갈래로 갈라서 돌려준다 — `{ text }` 넘길 말이 있음, `{ skip: true }` 모델이 없다고
  // 답함, `{ error }` 물어보지도 못함. 예전엔 셋 다 null 이라 화면에는 똑같이 SKIP 으로 떴고,
  // 타임아웃으로 잘려도 "넘길 게 없다"로 보여서 실패한 줄을 알 방법이 없었다.
  return new Promise((resolve) => {
    const isCodex = provider === "codex";
    const bin = isCodex ? (cfg.codexBin || "codex") : (cfg.claudeBin || "claude");
    const args = isCodex
      ? ["exec", "resume", "--json", sid, langInstruction]
      : ["--resume", sid, "-p", langInstruction, "--output-format", "json"];
    const child = spawn(bin, args, {
      cwd: cfg.projectDir,
      env: { ...process.env, ...(cfg.env || {}) },
      // stderr 를 버리지 않는다. 실패 원인이 여기로만 나오는데 예전엔 ignore 였다.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    // 세션이 크면 이어받는 데만 한참 걸린다 — 17MB 세션에서 첫 응답까지 12초가 나왔다.
    // 30초는 그 경계에 너무 붙어 있어서, 될 일도 잘려서 SKIP 으로 둔갑했다.
    const timeoutMs = cfg.ctbNotifyTimeout || 180_000;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const detail = err.trim().split("\n").pop() || "";
      if (timedOut) return resolve({ error: `${bin} did not answer within ${Math.round(timeoutMs / 1000)}s (session may be too large — raise ctbNotifyTimeout)` });
      if (code !== 0) return resolve({ error: `${bin} exited ${code}${detail ? ` — ${detail}` : ""}` });
      try {
        let text = "";
        if (isCodex) {
          for (const line of out.split("\n")) {
            try {
              const event = JSON.parse(line);
              if (event.type === "item.completed" && event.item?.type === "agent_message") text = event.item.text || text;
            } catch {}
          }
        } else {
          text = JSON.parse(out).result || "";
        }
        text = text.trim();
        if (!text) return resolve({ error: `${bin} returned nothing${detail ? ` — ${detail}` : ""}` });
        return resolve(/^skip$/i.test(text) ? { skip: true } : { text });
      } catch {
        return resolve({ error: `cannot read ${bin} output${detail ? ` — ${detail}` : ""}` });
      }
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ error: `cannot run ${bin} — ${e.message}` }); });
  });
}

async function notifyTelegram(configPath, provider, sessionId, chatId) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    // allowedChatId 는 문자열 또는 배열 모두 허용 (bot.mjs의 allowedIds와 동일 규칙).
    const chatIds = [].concat(cfg.allowedChatId).filter(Boolean).map(String);
    if (!cfg.token || !chatIds.length || cfg.ctbNotify === false) return;
    // 이어받은 그 방에만 보낸다. 전에는 allowedChatId 전부에 뿌려서, DM 세션을 붙잡고 일한
    // 내용이 그룹방에도 그대로 떴다. 방마다 세션이 갈리는데 알림만 안 갈린 셈이다.
    // 화이트리스트 밖의 방(--chat 오타 등)이면 첫 방으로 물러선다 — 봇이 서비스하지 않는
    // 방으로 세션 내용을 보내지 않기 위해서다.
    const target = chatIds.includes(String(chatId)) ? String(chatId) : chatIds[0];
    const lang = cfg.lang || process.env.LANG || "";
    process.stderr.write("ctb: preparing handoff...\n");
    const result = await summarizeSession(provider, sessionId, lang, cfg);
    // 실패와 "넘길 게 없음"을 갈라서 찍는다 — 둘을 한 문구로 뭉치면 조용히 망가진 걸 못 본다.
    if (result.error) { process.stderr.write(`ctb: handoff failed — ${result.error}\n`); return; }
    if (result.skip) { process.stderr.write("ctb: nothing to hand over (SKIP)\n"); return; }
    const summary = result.text;
    process.stderr.write(`ctb: sending to Telegram (chat ${target}) — ${summary}\n`);
    const label = lang.startsWith("ko") ? "[터미널]" : "[local]";
    // 여러 줄이면 꼬리표를 따로 한 줄로 — 본문이 길어지면 한 줄에 붙일 때 읽기 나쁘다.
    const text = `💻 ${label}${summary.includes("\n") ? "\n" : " "}${summary}`;
    const r = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: target, text }),
    });
    const json = await r.json();
    if (!json.ok) process.stderr.write(`ctb: Telegram error — ${JSON.stringify(json)}\n`);
  } catch (e) {
    process.stderr.write(`ctb: notify error — ${e.message}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`ctb: ${e.message}\n`);
  process.exit(1);
});
