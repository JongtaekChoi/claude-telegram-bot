#!/usr/bin/env node
// ctb — short-form CLI for claude-telegram-bot
//
// ctb [config.json] [--provider claude|codex] [--chat <id>] [...provider args]
//                                      Resume the provider's Telegram session. With no arguments
//                                      it asks which room to continue (skipped when there is only
//                                      one, or when stdin is not a TTY); --chat picks it outright.
// ctb send [config.json] --chat <room> [--file <path>] [--now] <message>
//                                      Hand a message (or files) to the RUNNING bot for that room
// ctb rooms [config.json]              List the rooms this bot knows, with the key --chat takes
// ctb bot [config.json]                Start the Telegram bot daemon (delegates to bot.mjs)
// ctb init [dir]                       Create a config.json template
// ctb --help | --version
//
// config.json is optional. Without it: $BOT_CONFIG, then mybot.json / config.json in the current
// directory, then the same names in the package directory. A bare name like "planner.json" resolves
// relative to the current directory first, then the package directory.
// Absolute or explicitly relative paths (/ or ./) resolve as-is.
//
// While a provider runs, .claude-bot/local.lock records the PID and the room being held, so the
// bot defers incoming Telegram messages for that room only — every other room keeps answering.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

// config.json → .claude-bot/state.json, planner.json → .claude-bot/planner.state.json.
// 고르기 화면과 세션 이어받기가 같은 파일을 보게 한 곳에 둔다 — 갈리면 목록에 없는 방을 이어받는다.
function statePathFor(configPath) {
  const base = basename(configPath, ".json");
  return join(dirname(configPath), ".claude-bot", base === "config" ? "state.json" : `${base}.state.json`);
}
// 방이 가리키는 페르소나 — bot.mjs 의 roomPersona 와 **같은 규칙이어야 한다.** 고르지 않은 방은
// 기본값(personas[0]). 여기가 어긋나면 터미널과 봇이 서로 다른 역할·다른 메모리로 돈다.
function personaFor(cfg, room) {
  const ok = (p) => p && typeof p.id === "string" && /^[a-z0-9][a-z0-9-]*$/i.test(p.id.trim())
    && typeof p.prompt === "string" && p.prompt.trim();
  const list = Array.isArray(cfg.personas) ? cfg.personas.filter(ok) : [];
  if (!list.length) return null;
  return list.find((p) => p.id.trim() === room?.persona) || list[0];
}
// 방의 작업 폴더 — bot.mjs 의 roomDir 과 **같은 규칙이어야 한다.** 역할이 dir 을 가지면 터미널도
// 그 폴더에서 열려야 한다. 여기가 어긋나면 `ctb --chat 기획` 이 개발 폴더에서 뜨고, 그 폴더의
// CLAUDE.md 를 읽고, 이어받은 세션과 cwd 가 달라진다. → docs/design/room-personas.md
function projectDirFor(cfg, room) {
  const dir = personaFor(cfg, room)?.dir;
  return dir ? resolve(cfg.projectDir || ".", dir) : cfg.projectDir;
}
// 메모리도 같은 규칙으로 가른다 — bot.mjs 의 memoryPathFor 와 짝이어야 한다. 여기가 어긋나면
// 터미널과 봇이 서로 다른 규칙을 읽는다. 방이 페르소나를 가리키면 그 id 까지 붙인다.
// config.json → .claude-bot/memory.md · memory.dev.md / planner.json → planner.memory.md
// 소켓 이름도 state·memory 와 같은 규칙으로 config 에서 파생된다 — 한 폴더에 봇이 여럿이면
// 이름이 하나일 때 서로의 소켓을 지우고 빼앗는다. bot.mjs 의 SOCK_PATH 와 짝이다.
function sockPathFor(configPath) {
  const base = basename(configPath, ".json");
  return join(dirname(configPath), ".claude-bot", base === "config" ? "ctb.sock" : `${base}.ctb.sock`);
}
function memoryPathFor(configPath, personaId) {
  const base = basename(configPath, ".json");
  const stem = base === "config" ? "memory" : `${base}.memory`;
  const safe = personaId && /^[a-z0-9][a-z0-9-]*$/i.test(personaId); // id 가 파일명이 된다
  return join(dirname(configPath), ".claude-bot", safe ? `${stem}.${personaId}.md` : `${stem}.md`);
}

// 한글·CJK 는 터미널에서 두 칸을 먹는다 — padEnd 는 글자 수만 세서 표가 어긋난다.
const cellWidth = (s) =>
  [...s].reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
const pad = (s, w) => s + " ".repeat(Math.max(0, w - cellWidth(s)));

// 고르기 화면에 뿌릴 방 목록. 기본으로 이어받는 방이 맨 위, 화이트리스트에서 빠진 방(그룹 승격으로
// 죽은 옛 ID 등)이 맨 아래다.
function roomRows(st, cfg) {
  const allowed = [].concat(cfg.allowedChatId).filter(Boolean).map(String);
  const primary = allowed[0];
  const base = (room) => (room.indexOf(":") < 0 ? room : room.slice(0, room.indexOf(":")));
  return Object.entries(st.sessions || {})
    .map(([room, r]) => {
      const provider = r.provider || st.provider || cfg.provider || "claude";
      const sid = r[provider === "codex" ? "codexSessionId" : "sessionId"];
      return {
        room,
        // 이름은 봇이 메시지를 받아야 채워진다 — 0.4.13 이하 state 에는 아예 없다.
        name: r.title || "(unnamed)",
        provider,
        session: sid ? sid.slice(0, 8) : "-",
        primary: room === primary,
        live: allowed.includes(base(room)),
      };
    })
    .sort((a, b) =>
      Number(b.primary) - Number(a.primary) ||
      Number(b.live) - Number(a.live) ||
      a.room.localeCompare(b.room));
}

// 시작할 때 뜨는 방 고르기. 화살표로 옮기고 엔터로 고른다 — 숫자 키도 받는다.
// 화면은 stderr 로 그린다. stdout 은 `-p` 로 받은 답이 나가는 통로라 섞이면 안 된다.
//
// 안 뜨는 경우가 뜨는 경우보다 중요하다:
//   · TTY 가 아니면(백그라운드 작업·파이프) 물어볼 상대가 없다 — 프롬프트를 띄우면 그대로 멈춘다
//   · 방이 하나뿐이면 물어봐야 답이 정해져 있다
//   · `--chat`·`-p` 처럼 이미 뜻이 분명한 인자가 있으면 부르지도 않는다 (호출부 참고)
async function pickRoom(rows) {
  if (rows.length < 2 || !process.stdin.isTTY || !process.stderr.isTTY) return undefined;

  const w = (key) => Math.max(...rows.map((r) => cellWidth(String(r[key]))));
  const [wn, wr] = [w("name"), w("room")];
  // 방 키까지 보여준다 — `--chat` 에 넣을 값이 여기 말고는 볼 데가 없고, 화이트리스트에서 빠진 방을
  // 알아보는 것도 여기가 유일하다(그룹이 승격되면 옛 ID 의 세션이 닿을 수 없는 채로 남는다).
  const line = (r, i, on) =>
    `${on ? "\x1b[36m❯ " : "  "}${String(i + 1).padStart(2)}  ${pad(r.name, wn)}  ` +
    `${pad(r.room, wr)}  ${r.provider}  ${r.session}` +
    `${r.primary ? "  *" : ""}${r.live ? "" : "  (not in allowedChatId)"}${on ? "\x1b[0m" : ""}`;

  let cur = 0;
  const draw = (redraw) => {
    // 다시 그릴 때는 커서를 목록 첫 줄로 올리고 아래를 통째로 지운다 — 줄마다 지우면 길이가
    // 바뀔 때 찌꺼기가 남는다.
    if (redraw) process.stderr.write(`\x1b[${rows.length}A\x1b[0J`);
    process.stderr.write(rows.map((r, i) => line(r, i, i === cur)).join("\n") + "\n");
  };

  process.stderr.write("Pick a room  (↑↓ or 1-9, enter to start, q to cancel)\n");
  process.stderr.write("\x1b[?25l"); // 커서 숨김 — 목록 위를 오르내리는 게 보이면 지저분하다
  process.stdin.setRawMode(true);
  process.stdin.resume();
  draw(false);

  // raw 모드로 둔 채 죽으면 터미널이 먹통이 된다. 어떤 경로로 끝나든 되돌린다.
  const restore = () => {
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
    process.stderr.write("\x1b[?25h");
  };
  process.on("exit", restore);

  return new Promise((resolve) => {
    const onKey = (buf) => {
      const k = buf.toString();
      const done = (room) => {
        process.stdin.off("data", onKey);
        restore();
        resolve(room);
      };
      if (k === "\r" || k === "\n") return done(rows[cur].room);
      if (k === "\x03" || k === "q" || k === "\x1b") { // ctrl-c · q · esc
        done(null);
        process.stderr.write("cancelled\n");
        return process.exit(130);
      }
      if (k === "\x1b[A" || k === "k") cur = (cur - 1 + rows.length) % rows.length;
      else if (k === "\x1b[B" || k === "j") cur = (cur + 1) % rows.length;
      else if (/^[1-9]$/.test(k) && Number(k) <= rows.length) return done(rows[Number(k) - 1].room);
      else return;
      draw(true);
    };
    process.stdin.on("data", onKey);
  });
}

// 터미널에서 도는 에이전트에게 `ctb send` 가 있다는 걸 알려준다. 이 기능을 만든 이유가 바로 이
// 자리(에이전트가 옆방에 일을 넘기는 것)인데, 사용법을 안 실으면 README 를 읽은 에이전트만 우연히
// 알게 된다. **소켓이 실제로 있을 때만** 붙인다 — 봇 없이 터미널만 쓰는 사람은 토큰을 안 낸다.
// 방에서 도는 에이전트에게는 안 준다: 옆방에 넘기는 건 거기선 `[[ctb-tell:]]` 마커의 몫이고,
// 길이 둘이면 모델이 갈린다. → docs/design/cli-dispatch.md
//
// 자기 방은 **글자 요청** 목록에서만 뺀다. 파일 올리기는 실행이 아니라서 자기 방으로도 정상이고, 실제로
// 그 방 ID 를 얻을 길이 없어 엉뚱한 DM 에 올린 일이 있었다(0.7.0) — 그래서 자기 방 키를 따로 적어 준다.
function dispatchInstruction(configPath, st, ownRoom) {
  if (!existsSync(sockPathFor(configPath))) return null;
  const rooms = Object.entries(st.sessions || {})
    .filter(([room, b]) => b?.title && room !== String(ownRoom))
    .map(([room, b]) => `  ${room}  — ${b.title}`);
  const own = ownRoom ? String(ownRoom) : null;
  if (!rooms.length && !own) return null; // 넘길 방도 올릴 방도 없으면 아무것도 안 붙인다
  const lines = ["## Handing work to this project's Telegram bot",
    "The bot is running right now."];
  if (own) lines.push(
    `This terminal is attached to room ${own}${st.sessions?.[own]?.title ? ` (${st.sessions[own].title})` : ""}`
      + " — also in $CTB_CHAT_ID. To post a file (screenshot, PDF, recording) into it as-is,",
    "with no agent run and no approval:\n",
    '  ctb send --file /abs/path.png "optional caption"     (defaults to $CTB_CHAT_ID)\n');
  if (rooms.length) lines.push(
    "From this terminal you can also give another room a message and it will run it **in that room** —",
    "that room's own session, role and settings — and print the answer back here:\n",
    '  ctb send --chat <room> "<message>"',
    '  ctb send --chat <room> --file /abs/path.png "caption"   (post a file there, no agent run)\n',
    "Use it to ask another room (often another role) for something you should not do yourself here.",
    "A message cannot go to this terminal's own room (it is held by this session).",
    "A message waits for ✅ in the target room — add `--now` only when the person told you to skip it.",
    "It waits for the answer, so that room's queue is your wait. Rooms:",
    rooms.join("\n"));
  return lines.join("\n");
}

// `ctb send` — 프롬프트를 **돌고 있는 봇에** 넘긴다. 봇이 그 방에서 처리하므로 typing 이 돌고
// 답이 그 방에 남는다. 봇이 안 떠 있으면 그냥 실패한다 — 조용히 로컬 실행으로 물러서면 방 안내도
// typing 도 없이 돌아서, 원한 것과 정반대인데 성공한 것처럼 보인다. → docs/design/cli-dispatch.md
function resolveRoomToken(token, sessions) {
  const rooms = Object.entries(sessions || {})
    .filter(([, b]) => b?.title)
    .map(([room, b]) => ({ room, title: b.title }));
  if (sessions?.[token]) return { room: token };
  const needle = String(token).toLowerCase();
  const hits = rooms.filter((r) => r.title.toLowerCase().includes(needle));
  if (hits.length === 1) return { room: hits[0].room };
  if (hits.length > 1) return { ambiguous: hits };
  return { rooms };
}

const SEND_HELP =
  `Usage: ctb send [config.json] [--chat <room>] [--now] <message>\n` +
  `       ctb send [config.json] [--chat <room>] --file <path> [--file <path>] [caption]\n\n` +
  `Hands a message to the RUNNING bot (\`ctb bot\`). It runs in that room — typing, that room's\n` +
  `session and settings, the answer posted there — and the answer is printed on stdout.\n\n` +
  `  --chat <room>   Room key (see \`ctb rooms\`) or any distinctive part of its name.\n` +
  `                  Optional when the bot knows only one room. With --file it defaults to\n` +
  `                  $CTB_CHAT_ID — the room of the session you are calling from.\n` +
  `  --now           Run a message without waiting for ✅ in the room (the room is told anyway).\n` +
  `  --file <path>   Post the file as-is: no agent run, no session, no approval. Repeatable,\n` +
  `                  up to 10. Photos ≤10MB, anything else ≤50MB. Leftover words = caption.\n` +
  `  -h, --help      This help.\n`;

async function sendToBot(rest) {
  if (rest.some((x) => x === "-h" || x === "--help")) { process.stdout.write(SEND_HELP); return; }
  // `ctb send "bump package.json" --chat dev` 처럼 **본문**이 .json 으로 끝날 수 있다. 공백이
  // 들어간 건 파일 이름이 아니라 문장으로 본다 — 여기 인자 1은 명령이 아니라 사람 말이다.
  const looksLikeConfig = rest[0]?.endsWith(".json") && !/\s/.test(rest[0]);
  const configPath = resolveConfig(looksLikeConfig ? rest[0] : undefined);
  const rest2 = looksLikeConfig ? rest.slice(1) : rest;
  let room, now = false;
  const words = [], files = [];
  for (let i = 0; i < rest2.length; i++) {
    const arg = rest2[i];
    if (arg === "--chat") room = rest2[++i];
    else if (arg.startsWith("--chat=")) room = arg.slice("--chat=".length);
    else if (arg === "--file") files.push(rest2[++i]);
    else if (arg.startsWith("--file=")) files.push(arg.slice("--file=".length));
    else if (arg === "--now") now = true;
    // 모르는 플래그를 본문에 섞으면 오타가 그대로 방에 실행 요청으로 간다(`--hlep` 처럼).
    // 플래그처럼 생긴 말을 보내야 하면 `--` 뒤에 둔다.
    else if (arg === "--") { words.push(...rest2.slice(i + 1)); break; }
    else if (/^--?[a-z]/i.test(arg)) {
      process.stderr.write(`ctb send: unknown option ${arg}\n\n${SEND_HELP}`);
      process.exit(2);
    }
    else words.push(arg);
  }
  const text = words.join(" ").trim();
  // `--file` 은 **그 방에 파일을 올린다.** 글자와 달리 세션을 돌리지 않는다 — 스크린샷 한 장
  // 올리자고 턴과 토큰을 쓸 이유가 없다. 남은 말은 캡션이 된다. → docs/design/cli-dispatch.md
  if (files.length) {
    for (let i = 0; i < files.length; i++) {
      const raw = files[i];
      if (!raw) { process.stderr.write("ctb send: --file needs a path\n"); process.exit(2); }
      const abs = resolve(raw);
      // 여기서 먼저 보는 이유는 메시지다 — 봇이 거절해도 그 방에만 뜨고 터미널엔 경로가 안 남는다.
      if (!existsSync(abs)) { process.stderr.write(`ctb send: no such file: ${abs}\n`); process.exit(2); }
      files[i] = abs;
    }
  } else if (!text) {
    process.stderr.write("ctb send: no message given\n");
    process.exit(2);
  }

  let st = {};
  try { st = JSON.parse(readFileSync(statePathFor(configPath), "utf8")); } catch {}
  // 파일은 실행이 아니라서 부른 세션의 방에 올리는 게 정상이다 — 방에서 도는 에이전트와 `ctb` 세션
  // 모두 CTB_CHAT_ID 를 받는다. 글자는 안 된다: 자기 방은 그 세션이 쥐고 있어 큐에서 안 나온다.
  if (!room && files.length && process.env.CTB_CHAT_ID) room = process.env.CTB_CHAT_ID;
  if (!room) {
    // 방을 안 주면 아는 방이 하나뿐일 때만 그걸 쓴다 — 스크립트에서 엉뚱한 방으로 가면 안 된다.
    const known = Object.entries(st.sessions || {}).filter(([, b]) => b?.title);
    if (known.length !== 1) {
      process.stderr.write("ctb send: --chat is required (see `ctb send --help`). Rooms this bot knows:\n");
      for (const [k, b] of known) process.stderr.write(`  ${k}  ${b.title}\n`);
      process.exit(2);
    }
    room = known[0][0];
  } else {
    const hit = resolveRoomToken(room, st.sessions);
    if (hit.ambiguous) {
      process.stderr.write("ctb send: that matches more than one room:\n");
      for (const r of hit.ambiguous) process.stderr.write(`  ${r.room}  ${r.title}\n`);
      process.exit(2);
    }
    if (!hit.room) {
      process.stderr.write(`ctb send: no room matches "${room}". Rooms this bot knows:\n`);
      for (const r of hit.rooms) process.stderr.write(`  ${r.room}  ${r.title}\n`);
      process.exit(2);
    }
    room = hit.room;
  }

  const sock = sockPathFor(configPath);
  const code = await new Promise((resolve) => {
    const conn = net.createConnection(sock);
    conn.setEncoding("utf8");
    let buf = "";
    // error 로 이미 알린 뒤에도 close 가 뒤따라 온다 — 한 번 끝냈으면 두 번 말하지 않는다.
    let settled = false;
    const finish = (c) => { if (!settled) { settled = true; resolve(c); } };
    conn.on("connect", () => conn.write(`${JSON.stringify({ room, text, now, ...(files.length ? { files } : {}) })}\n`));
    conn.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        // 중간 줄은 진행 상황(stderr), 마지막 줄만 결과(stdout)
        if (msg.ok === undefined) { process.stderr.write(`ctb: ${msg.status}${msg.hint ? ` — ${msg.hint}` : ""}\n`); continue; }
        // 파이프로 받는 게 이 명령의 쓰임이라 잘리면 안 된다 — 쓰기가 끝난 뒤에 종료한다.
        if (msg.ok) { process.stdout.write(`${msg.text}\n`, () => finish(0)); }
        else { process.stderr.write(`ctb send: ${msg.error}\n`); finish(1); }
      }
    });
    conn.on("error", (e) => {
      process.stderr.write(
        e.code === "ENOENT" || e.code === "ECONNREFUSED"
          ? `ctb send: no bot listening at ${sock} — start it with \`ctb bot\`\n`
          : `ctb send: ${e.message}\n`,
      );
      finish(1);
    });
    // 봇이 답을 주기 전에 끊기면 그 사실을 말해야 한다 — 종료 코드만 1이고 아무 말이 없으면
    // 왜 실패했는지 알 방법이 없다.
    conn.on("close", () => {
      if (!settled) process.stderr.write("ctb send: the bot closed the connection without answering\n");
      finish(1);
    });
  });
  process.exitCode = code;
}

// `ctb rooms` — `--chat` 이 받는 방 키를 보여준다. 예전엔 볼 길이 `ctb send` 의 에러 메시지뿐이었다.
function listRooms(rest) {
  const configPath = resolveConfig(rest[0]?.endsWith(".json") ? rest[0] : undefined);
  let cfg = {}, st = {};
  try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch {
    process.stderr.write(`ctb rooms: cannot read ${configPath}\n`);
    process.exit(1);
  }
  try { st = JSON.parse(readFileSync(statePathFor(configPath), "utf8")); } catch {}
  const rows = roomRows(st, cfg);
  process.stderr.write(`config: ${configPath}\n`);
  if (!rows.length) { process.stderr.write("(no rooms yet — the bot records a room when it first answers there)\n"); return; }
  const wRoom = Math.max(...rows.map((r) => cellWidth(r.room)));
  const wName = Math.max(...rows.map((r) => cellWidth(r.name)));
  for (const r of rows) {
    const tail = [r.primary ? "*" : "", r.live ? "" : "(not in allowedChatId)"].filter(Boolean).join(" ");
    console.log(`${pad(r.room, wRoom)}  ${pad(r.name, wName)}  ${pad(r.provider, 6)}  ${r.session}${tail ? `  ${tail}` : ""}`);
  }
}

// 첫 인자가 알려진 하위 명령이 아닌 **맨 단어**면 멈춘다. 예전엔 그대로 provider 프롬프트로 넘어가서,
// `ctb rooms` 가 기본 방(DM)의 세션을 'rooms' 라는 말로 깨우고 끝날 때 인수인계까지 그 방에 올렸다.
// 문장(공백 포함)·플래그·config 파일은 그대로 통과한다 — 한 단어 프롬프트는 `ctb -- <단어>` 로.
const SUBCOMMANDS = ["send", "rooms", "bot", "init"];
function unknownSubcommand(word) {
  return typeof word === "string" && /^[a-z][a-z0-9-]*$/i.test(word) && !SUBCOMMANDS.includes(word);
}

async function main() {
  if (a === "-h" || a === "--help") {
    console.log(
      `ctb v${VERSION} — claude-telegram-bot short CLI\n\n` +
      `Usage:\n` +
      `  ctb [config.json] [--provider claude|codex] [--chat <id>] [...args]\n` +
      `                                Resume the provider's Telegram session\n` +
      `                                (bare \`ctb\` asks which room, unless there is only one)\n` +
      `  ctb send [config.json] --chat <room> [--now] <message>\n` +
      `                                Hand a message to the RUNNING bot — it runs in that room,\n` +
      `                                with typing and the answer posted there. Needs \`ctb bot\` up.\n` +
      `                                Asks for approval in that room unless --now.\n` +
      `  ctb send --chat <room> --file <path> [--file <path>] [--now] [caption]\n` +
      `                                Post files to that room as-is — no agent, no session,\n` +
      `                                no approval.\n` +
      `                                Photos up to 10MB, anything else up to 50MB, 10 per call.\n` +
      `                                Defaults to $CTB_CHAT_ID (the calling session's room).\n` +
      `                                \`ctb send --help\` lists every option.\n` +
      `  ctb rooms [config.json]       List known rooms and the key --chat takes\n` +
      `  ctb bot [config.json]         Start the Telegram bot daemon\n` +
      `  ctb init [dir]                Create a config.json template\n` +
      `  ctb --help | --version\n\n` +
      `config.json defaults to $BOT_CONFIG, then mybot.json / config.json in the current directory,\n` +
      `then the same names in the package directory — so run ctb from the bot's folder.\n` +
      `A bare name like "planner.json" resolves relative to the current directory, then the package.\n\n` +
      `Provider precedence: --provider flag → /provider override in state → config.provider → claude.\n\n` +
      `Examples:\n` +
      `  ctb                           Pick a room, then continue its session interactively\n` +
      `  ctb -p "what did we do?"      Headless configured provider with session context\n` +
      `  ctb planner.json              Resume planner persona session interactively\n` +
      `  ctb planner.json -p "..."     Headless with planner session\n` +
      `  ctb planner.json --provider codex  Interactive Codex with its Telegram session\n` +
      `  ctb --chat -1002233445566:11  Resume that forum topic's session instead of the DM\n` +
      `  ctb send --chat 플랜 "테스트 돌려줘"   Ask the bot to run it in the 플랜 room\n` +
      `  ctb send --chat 플랜 --file shot.png --now "방금 화면"  Post a file to that room\n` +
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

  if (a === "send") {
    await sendToBot(args.slice(1));
    return;
  }

  if (a === "rooms") {
    listRooms(args.slice(1));
    return;
  }

  if (unknownSubcommand(a)) {
    process.stderr.write(
      `ctb: unknown command "${a}". Commands: ${SUBCOMMANDS.join(", ")} (see \`ctb --help\`).\n`
      + `To start a session with that word as the prompt, use \`ctb -- ${a}\`.\n`,
    );
    process.exit(2);
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
  const botDir = join(dirname(configPath), ".claude-bot");
  const statePath = statePathFor(configPath);
  const lockPath = join(botDir, "local.lock");

  let st = {};
  try { st = JSON.parse(readFileSync(statePath, "utf8")); } catch {}

  // 인자 없이 그냥 `ctb` 를 쳤으면 어느 방을 이어받을지 묻는다. 방 키를 외워 `--chat` 에 넣는 건
  // 사실상 불가능하고, 주제를 쓰기 시작하면 방이 계속 늘어난다. 인자가 하나라도 있으면 뜻이 이미
  // 분명하니(`-p "..."` 는 헤드리스, `--chat` 은 방 지정) 묻지 않는다 — pickRoom 이 방 개수와
  // TTY 여부도 다시 확인해서, 방이 하나뿐이거나 물어볼 상대가 없으면 그냥 지나간다.
  if (!chatOverride && !forwardedArgs.length) {
    chatOverride = await pickRoom(roomRows(st, cfg));
  }

  const primaryChatId = chatOverride
    ? String(chatOverride)
    : [].concat(cfg.allowedChatId).filter(Boolean).map(String)[0];
  const room = primaryChatId ? st.sessions?.[primaryChatId] : undefined;
  const projectDir = projectDirFor(cfg, room); // 역할이 dir 을 가지면 터미널도 그 폴더에서 연다
  // Telegram 의 /provider·/model override 는 방별이다. --chat 이 고른 방의 설정을 그대로 따른다.
  // 최상위 키는 0.4.13 이하 state 파일을 bot이 아직 마이그레이션하지 않은 경우의 호환 폴백이다.
  const stateProvider = room?.provider || st.provider;
  const provider = providerOverride || stateProvider || cfg.provider || "claude";
  if (!["claude", "codex"].includes(provider)) {
    throw new Error(`Unsupported provider: ${provider} (expected claude or codex)`);
  }

  mkdirSync(botDir, { recursive: true });
  // 어느 방을 잡고 있는지 같이 적는다 — 봇은 그 방만 미루고 나머지는 평소대로 답한다.
  // 첫 줄은 PID 만 둔 채로 남긴다. 0.4.13 이전 봇은 이 파일을 `parseInt` 로 읽는데, 통째로 JSON 을
  // 적으면 NaN 이 되고 그 경로는 "죽은 lock" 으로 판정해 **파일을 지워 버린다** — 잠금이 아예
  // 풀린다. 옛 봇은 첫 줄만 읽고, 새 봇은 둘째 줄까지 읽는다.
  writeFileSync(lockPath, `${process.pid}\n${JSON.stringify({ room: primaryChatId })}\n`);
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
  const sessionId = room?.[sessionKey] || st[sessionKey];

  if (sessionId) {
    // 어느 방의 세션인지 같이 찍는다 — 방마다 세션이 갈리는데 화면에는 세션 ID 만 떠서,
    // DM 을 이어받았는지 그룹을 이어받았는지 확인할 방법이 없었다.
    process.stderr.write(`Resuming ${provider} session: ${sessionId} (chat ${primaryChatId})\n`);
    if (provider === "claude") {
      // 텔레그램 이전 대화와 구분하기 위해 Claude 세션에 시작 마커 삽입.
      // 마커는 `-` 로 시작하면 안 된다 — claude 의 인자 파서가 `-p` 의 값이 아니라 옵션으로 읽고
      // `unknown option` 으로 죽는다. 예전 마커(`---ctb:start---`)가 그래서 한 번도 안 들어갔다.
      await new Promise((resolve) => {
        const marker = spawn(cfg.claudeBin || "claude", [
          "--resume", sessionId, "-p", "<ctb:start>", "--output-format", "json",
        ], { cwd: projectDir, env: { ...process.env, ...(cfg.env || {}) }, stdio: ["ignore", "ignore", "ignore"] });
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
    const persona = personaFor(cfg, room);
    try { memory = readFileSync(memoryPathFor(configPath, persona?.id), "utf8").trim(); } catch {}
    // 메모리를 persona 앞에 두고 헤더를 세게 다는 것까지 bot.mjs 와 같게 — persona 가 덮어쓰지 않게.
    const appendSys = [
      memory ? `## RULES (must follow before anything else)\n${memory}` : null,
      persona?.prompt || cfg.persona,
      // 이것만은 파일에서 오는 값이 아니라 이 자리에서 만든다 — 터미널에서만 쓸 수 있는 통로라
      // "텔레그램용 문구는 뺀다"는 규칙에 걸리지 않는다. 오히려 터미널 전용이다.
      dispatchInstruction(configPath, st, primaryChatId),
    ].filter(Boolean).join("\n\n");
    if (appendSys) sysArgs.push("--append-system-prompt", appendSys);
  }
  // forwardedArgs 는 항상 맨 끝 — `-p <프롬프트>` 로 끝나는 호출에서 순서가 깨지면 안 된다.
  const hasModelArg = forwardedArgs.some((a) => a === "--model" || a.startsWith("--model="));
  const roomModel = provider === "codex"
    ? (room?.codexModel || st.codexModel || cfg.codexModel)
    : (room?.model || st.model || cfg.model);
  const modelArgs = roomModel && !hasModelArg ? ["--model", roomModel] : [];
  const finalArgs = provider === "codex"
    ? (sessionId ? ["resume", ...modelArgs, sessionId, ...forwardedArgs] : [...modelArgs, ...forwardedArgs])
    : [...(sessionId ? ["--resume", sessionId] : []), ...modelArgs, ...sysArgs, ...forwardedArgs];
  // CTB_CHAT_ID: 여기서 띄운 백그라운드 작업(.ctb-jobs)이 끝났을 때 봇이 어느 방으로 알릴지.
  // 텔레그램 경로(bot.mjs 의 jobEnv)와 같은 값을 넣어 두 입구가 똑같이 동작하게 한다.
  const child = spawn(bin, finalArgs, {
    cwd: projectDir,
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
async function summarizeSession(provider, sid, lang, cfg, projectDir) {
  // `<ctb:` 로 시작하는 건 사람이 친 게 아니라 ctb 가 끼워 넣은 턴이다. 세션 시작 마커도 같은
  // 규칙을 쓰고, bot.mjs 의 /sessions 미리보기가 이 접두사 하나로 둘 다 걸러낸다 — 문구가 바뀔
  // 때마다 저쪽 정규식을 따라 고치던 걸 없애려고 태그로 묶었다.
  // `<` 로 여는 건 취향이 아니라 필수다 — `-` 로 시작하면 claude 가 `-p` 의 값이 아니라 옵션으로
  // 읽고 `unknown option` 으로 죽는다(그래서 인수인계가 통째로 실패했다).
  const langInstruction = "<ctb:handoff>\n" + (lang && lang.startsWith("ko")
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
      cwd: projectDir,
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
    let st = {};
    try { st = JSON.parse(readFileSync(statePathFor(configPath), "utf8")); } catch {}
    // 화이트리스트는 봇과 같은 세 갈래를 합친다 — config 만 보면 `/allow` 로 연 그룹이 "모르는 방"이
    // 되어 DM 으로 샜다. (allowedChatId 는 문자열 또는 배열 모두 허용, bot.mjs 의 allowedIds 와 동일)
    const chatIds = [...new Set([
      ...[].concat(cfg.allowedChatId),
      ...(st.allowedChatIds || []),
      ...(st.adoptedChatIds || []),
    ].filter(Boolean).map(String))];
    if (!cfg.token || !chatIds.length || cfg.ctbNotify === false) return;
    // 이어받은 그 방에만 보낸다. 전에는 allowedChatId 전부에 뿌려서, DM 세션을 붙잡고 일한
    // 내용이 그룹방에도 그대로 떴다. 방마다 세션이 갈리는데 알림만 안 갈린 셈이다.
    // **토픽 방은 키가 `그룹:스레드` 라 화이트리스트와 통째로 비교하면 안 맞는다.** 예전엔 그래서
    // 토픽 세션의 요약이 전부 DM 으로 갔다(2026-09-14). 그룹 부분으로 허용 여부를 보고, 보낼 때는
    // 스레드까지 실어 그 토픽으로 넣는다.
    // 화이트리스트 밖의 방(--chat 오타 등)이면 첫 방으로 물러선다 — 봇이 서비스하지 않는
    // 방으로 세션 내용을 보내지 않기 위해서다.
    const [base, thread] = String(chatId).split(":");
    const allowed = chatIds.includes(base);
    const target = allowed ? { chat_id: base, ...(thread ? { message_thread_id: Number(thread) } : {}) }
                           : { chat_id: chatIds[0] };
    const lang = cfg.lang || process.env.LANG || "";
    process.stderr.write("ctb: preparing handoff...\n");
    // 인수인계 요약도 그 방의 작업 폴더에서 돈다 — 세션을 이어받는 것이므로 cwd 가 갈리면 안 된다.
    const room = st.sessions?.[String(chatId)];
    const result = await summarizeSession(provider, sessionId, lang, cfg, projectDirFor(cfg, room));
    // 실패와 "넘길 게 없음"을 갈라서 찍는다 — 둘을 한 문구로 뭉치면 조용히 망가진 걸 못 본다.
    if (result.error) { process.stderr.write(`ctb: handoff failed — ${result.error}\n`); return; }
    if (result.skip) { process.stderr.write("ctb: nothing to hand over (SKIP)\n"); return; }
    const summary = result.text;
    process.stderr.write(`ctb: sending to Telegram (chat ${allowed ? chatId : target.chat_id}) — ${summary}\n`);
    const label = lang.startsWith("ko") ? "[터미널]" : "[local]";
    // 여러 줄이면 꼬리표를 따로 한 줄로 — 본문이 길어지면 한 줄에 붙일 때 읽기 나쁘다.
    const text = `💻 ${label}${summary.includes("\n") ? "\n" : " "}${summary}`;
    const r = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...target, text }),
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
