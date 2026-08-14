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
    process.stderr.write(`Resuming ${provider} session: ${sessionId}\n`);
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
  const finalArgs = provider === "codex"
    ? (sessionId ? ["resume", sessionId, ...forwardedArgs] : forwardedArgs)
    : (sessionId ? ["--resume", sessionId, ...forwardedArgs] : forwardedArgs);
  // CTB_CHAT_ID: 여기서 띄운 백그라운드 작업(.ctb-jobs)이 끝났을 때 봇이 어느 방으로 알릴지.
  // 텔레그램 경로(bot.mjs 의 jobEnv)와 같은 값을 넣어 두 입구가 똑같이 동작하게 한다.
  const child = spawn(bin, finalArgs, {
    cwd: cfg.projectDir,
    env: { ...process.env, ...(cfg.env || {}), ...(primaryChatId ? { CTB_CHAT_ID: primaryChatId } : {}) },
    stdio: "inherit",
  });
  child.on("close", async (code) => {
    cleanup();
    if (sessionId) await notifyTelegram(configPath, provider, sessionId);
    process.exit(signalExitCode ?? code ?? 0);
  });
  child.on("error", (e) => {
    cleanup();
    process.stderr.write(`ctb: failed to start ${provider}: ${e.message}\n`);
    process.exit(1);
  });
}

async function summarizeSession(provider, sid, lang, cfg) {
  const langInstruction = lang && lang.startsWith("ko")
    ? "방금 로컬 터미널 코딩 세션이 끝났어. 이 대화에서 가장 최근에 나눈 내용(이 메시지 직전까지)을 바탕으로, 그 세션에서 무엇을 했는지 한국어로 짧은 구문(10단어 이내)으로 요약해줘. 마크다운 없이 텍스트만. 중요한 작업이 없었으면 정확히 이렇게만 답해: SKIP"
    : "A local terminal coding session just ended. Based on the most recent exchanges in this conversation (just before this message), summarize in one short phrase (10 words max) what was accomplished. Plain text only. If nothing significant was done, reply exactly: SKIP";
  return new Promise((resolve) => {
    const isCodex = provider === "codex";
    const bin = isCodex ? (cfg.codexBin || "codex") : (cfg.claudeBin || "claude");
    const args = isCodex
      ? ["exec", "resume", "--json", sid, langInstruction]
      : ["--resume", sid, "-p", langInstruction, "--output-format", "json"];
    const child = spawn(bin, args, {
      cwd: cfg.projectDir,
      env: { ...process.env, ...(cfg.env || {}) },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => {
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
        resolve(/^skip$/i.test(text) ? null : text);
      } catch { resolve(null); }
    });
    child.on("error", () => resolve(null));
    setTimeout(() => { child.kill(); resolve(null); }, 30000);
  });
}

async function notifyTelegram(configPath, provider, sessionId) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    // allowedChatId 는 문자열 또는 배열 모두 허용 (bot.mjs의 allowedIds와 동일 규칙).
    const chatIds = [].concat(cfg.allowedChatId).filter(Boolean).map(String);
    if (!cfg.token || !chatIds.length || cfg.ctbNotify === false) return;
    const lang = cfg.lang || process.env.LANG || "";
    process.stderr.write("ctb: summarizing session...\n");
    const summary = await summarizeSession(provider, sessionId, lang, cfg);
    if (!summary) { process.stderr.write("ctb: nothing to summarize (SKIP)\n"); return; }
    process.stderr.write(`ctb: sending to Telegram — ${summary}\n`);
    const label = lang.startsWith("ko") ? "[터미널]" : "[local]";
    for (const chatId of chatIds) {
      const r = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: `💻 ${label} ${summary}` }),
      });
      const json = await r.json();
      if (!json.ok) process.stderr.write(`ctb: Telegram error — ${JSON.stringify(json)}\n`);
    }
  } catch (e) {
    process.stderr.write(`ctb: notify error — ${e.message}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`ctb: ${e.message}\n`);
  process.exit(1);
});
