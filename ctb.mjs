#!/usr/bin/env node
// ctb — short-form CLI for claude-telegram-bot
//
// ctb [config.json] [...claude args]   Run Claude, resuming the shared Telegram session
// ctb bot [config.json]                Start the Telegram bot daemon (delegates to bot.mjs)
// ctb init [dir]                       Create a config.json template
// ctb --help | --version
//
// config.json is optional. A bare name like "planner.json" resolves relative to the
// package directory (where bot configs typically live alongside bot.mjs).
// Absolute or explicitly relative paths (/ or ./) resolve as-is.
//
// While Claude runs, .claude-bot/local.lock (PID) is created so the bot defers
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
      `  ctb [config.json] [...args]   Resume Telegram session and run Claude\n` +
      `  ctb bot [config.json]         Start the Telegram bot daemon\n` +
      `  ctb init [dir]                Create a config.json template\n` +
      `  ctb --help | --version\n\n` +
      `config.json defaults to $BOT_CONFIG or the package's own config.json.\n` +
      `A bare name like "planner.json" resolves relative to the package directory.\n\n` +
      `Examples:\n` +
      `  ctb                           Interactive Claude, continuing the Telegram session\n` +
      `  ctb -p "what did we do?"      Headless Claude with session context\n` +
      `  ctb planner.json              Resume planner persona session interactively\n` +
      `  ctb planner.json -p "..."     Headless with planner session\n` +
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

  // Run Claude, resuming the bot's session
  const looksLikeConfig = a && a.endsWith(".json");
  const configPath = resolveConfig(looksLikeConfig ? a : undefined);
  const claudeArgs = looksLikeConfig ? args.slice(1) : args;

  const dataDir = dirname(configPath);
  const botDir = join(dataDir, ".claude-bot");
  const stateBase = basename(configPath, ".json");
  const stateFile = stateBase === "config" ? "state.json" : `${stateBase}.state.json`;
  const statePath = join(botDir, stateFile);
  const lockPath = join(botDir, "local.lock");

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

  let sessionId;
  try {
    sessionId = JSON.parse(readFileSync(statePath, "utf8")).sessionId;
  } catch {}

  if (sessionId) {
    process.stderr.write(`Resuming session: ${sessionId}\n`);
    // 텔레그램 이전 대화와 구분하기 위해 세션에 시작 마커 삽입
    await new Promise((resolve) => {
      const marker = spawn("claude", [
        "--resume", sessionId, "-p", "---ctb:start---", "--output-format", "json",
      ], { stdio: ["ignore", "ignore", "ignore"] });
      marker.on("close", resolve);
      marker.on("error", resolve);
      setTimeout(() => { marker.kill(); resolve(); }, 15000);
    });
  }

  const finalArgs = sessionId ? ["--resume", sessionId, ...claudeArgs] : claudeArgs;
  const child = spawn("claude", finalArgs, { stdio: "inherit" });
  child.on("close", async (code) => {
    cleanup();
    if (sessionId) await notifyTelegram(configPath, sessionId);
    process.exit(signalExitCode ?? code ?? 0);
  });
}

async function summarizeSession(sid, lang) {
  const langInstruction = lang && lang.startsWith("ko")
    ? "---ctb:start--- 마커 이후에 이 터미널 세션에서 한 작업을 한국어로 짧은 구문(10단어 이내)으로 요약해줘. 마크다운 없이 텍스트만. 마커 이후 중요한 작업이 없으면 정확히 이렇게만 답해: SKIP"
    : "After the ---ctb:start--- marker in this conversation, what was accomplished in this terminal session? One short phrase, 10 words max, plain text. If nothing significant after the marker, reply: SKIP";
  return new Promise((resolve) => {
    const child = spawn("claude", [
      "--resume", sid,
      "-p", langInstruction,
      "--output-format", "json",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => {
      try {
        const text = (JSON.parse(out).result || "").trim();
        resolve(/^skip$/i.test(text) ? null : text);
      } catch { resolve(null); }
    });
    child.on("error", () => resolve(null));
    setTimeout(() => { child.kill(); resolve(null); }, 30000);
  });
}

async function notifyTelegram(configPath, sessionId) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    if (!cfg.token || !cfg.allowedChatId || cfg.ctbNotify === false) return;
    const lang = cfg.lang || process.env.LANG || "";
    process.stderr.write("ctb: summarizing session...\n");
    const summary = await summarizeSession(sessionId, lang);
    if (!summary) { process.stderr.write("ctb: nothing to summarize (SKIP)\n"); return; }
    process.stderr.write(`ctb: sending to Telegram — ${summary}\n`);
    const label = lang.startsWith("ko") ? "[터미널]" : "[local]";
    const r = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.allowedChatId, text: `💻 ${label} ${summary}` }),
    });
    const json = await r.json();
    if (!json.ok) process.stderr.write(`ctb: Telegram error — ${JSON.stringify(json)}\n`);
  } catch (e) {
    process.stderr.write(`ctb: notify error — ${e.message}\n`);
  }
}

main();
