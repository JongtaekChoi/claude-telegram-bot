// 사용 집계 — 안 쓰는 기능을 걷어낼 근거. 이 머신의 봇 전부가 한 파일에 한 줄씩 덧붙이고,
// `/usage` 가 그걸 모아 "한 번도 안 쓴 것"까지 보여준다. 그리고 같이 들어간 `/restart`·`/ollama`
// 오너 DM 게이트.
import { mkdtempSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cut } from "./helpers/extract.mjs";
import { ok, eq, report } from "./helpers/assert.mjs";

const block = cut("const USAGE_LOG = join(", "\n// ── 방(chatId)별 세션");
const COMMANDS = { en: ["new", "sessions", "persona", "plan", "restart", "cron"].map((command) => ({ command })) };

function build(cfg, home) {
  return new Function(
    "cfg", "COMMANDS", "join", "dirname", "homedir", "mkdirSync", "appendFileSync", "readFileSync",
    `${block}\nreturn { USAGE_LOG, countUse, commandUseKey, readUsage };`,
  )(cfg, COMMANDS, join, dirname, () => home, mkdirSync, appendFileSync, readFileSync);
}

// ── 키 만들기 ────────────────────────────────────────────────────────────
{
  const u = build({ commands: { deploy: { run: "x" } } }, mkdtempSync(join(tmpdir(), "ctb-usage-")));
  eq("인자 없는 명령", u.commandUseKey("/new"), "/new");
  eq("허용된 하위 명령은 붙인다", u.commandUseKey("/persona add tester 테스터"), "/persona add");
  eq("자유 문장은 붙이지 않는다", u.commandUseKey("/plan add a button"), "/plan");
  eq("허용된 하위 명령", u.commandUseKey("/plan on"), "/plan on");
  eq("대문자 하위 명령도", u.commandUseKey("/plan OFF"), "/plan off");
  eq("커스텀 명령", u.commandUseKey("/deploy now"), "/deploy (custom)");
  eq("메뉴에 없는 숨은 명령도 센다", u.commandUseKey("/testfallback"), "/testfallback");
  eq("모르는 명령은 안 센다", u.commandUseKey("/whatever"), null);
  eq("명령이 아니면 null", u.commandUseKey("hello"), null);
}

// ── 덧붙이고 모으기 ──────────────────────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), "ctb-usage-"));
  const a = build({ name: "dev" }, home);
  const b = build({ name: "cube" }, home); // 다른 봇(다른 config) — 같은 파일에 쌓여야 한다
  eq("집계 전엔 null", a.readUsage(), null);
  a.countUse("/new"); a.countUse("/new"); b.countUse("/new"); b.countUse("/persona add");
  a.countUse(null); // 모르는 명령이면 commandUseKey 가 null — 아무것도 안 적는다
  a.countUse("button: /sessions");
  const lines = readFileSync(a.USAGE_LOG, "utf8").trim().split("\n");
  eq("한 줄씩 덧붙인다", lines.length, 5);
  ok("홈 아래 공용 파일", a.USAGE_LOG === join(home, ".claude-telegram-bot", "usage.jsonl"));
  appendFileSync(a.USAGE_LOG, '{"d":"2026-01-0'); // 쓰다 끊긴 줄
  appendFileSync(a.USAGE_LOG, '\n{"d":"2026-01-01","bot":"dev","k":"/new"}\n');
  const u = a.readUsage();
  eq("많이 쓴 순", u.keys[0][0], "/new");
  eq("봇을 가리지 않고 합친다", u.keys[0][1].n, 4);
  eq("가장 이른 날", u.since, "2026-01-01");
  eq("마지막 사용일은 최근 것", u.keys[0][1].last > "2026-01-01", true);
  eq("봇별 줄 수", Object.fromEntries(u.bots).cube, 2);
  ok("하위 명령으로 쓴 건 쓴 것", !u.never.includes("persona"));
  ok("버튼으로 쓴 건 쓴 것", !u.never.includes("sessions"));
  eq("한 번도 안 쓴 것", u.never.join(), "plan,restart,cron,newtopic,personaset,testfallback,usage");
}

// ── 집계 실패는 명령을 막지 않는다 ──────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), "ctb-usage-"));
  writeFileSync(join(home, ".claude-telegram-bot"), "디렉터리 자리에 파일"); // mkdir 이 실패한다
  const a = build({}, home);
  let threw = false;
  try { a.countUse("/new"); } catch { threw = true; }
  ok("쓰기 실패를 삼킨다", !threw);
}

// ── /restart · /ollama 게이트 ────────────────────────────────────────────
{
  const gate = cut('  if (text === "/restart" || text === "/ollama") {', '  if (text === "/usage") {');
  const run = async (text, owner, chatType) => {
    const sent = [], warned = [];
    const passed = await new Function(
      "text", "msg", "chatId", "l", "isOwner", "isGroupChat", "send", "t", "console",
      `return (async () => {\n${gate}\nreturn true; })();`,
    )(
      text, { from: { id: owner ? 1 : 2 }, chat: { type: chatType } }, "room", "en",
      (f) => f.id === 1, (c) => c.type === "group" || c.type === "supergroup",
      async (_, m) => sent.push(m), (_, k, a) => `${k}:${a}`, { warn: (m) => warned.push(m) },
    );
    return { passed: !!passed, sent, warned };
  };
  for (const cmd of ["/restart", "/ollama"]) {
    let r = await run(cmd, true, "private");
    ok(`${cmd}: 오너 DM 은 통과`, r.passed && !r.sent.length);
    r = await run(cmd, true, "supergroup");
    ok(`${cmd}: 오너가 그룹에서 치면 DM 안내`, !r.passed && r.sent[0] === `ownerDmOnly:${cmd}`);
    r = await run(cmd, false, "supergroup");
    ok(`${cmd}: 오너 아니면 응답 없이 로그만`, !r.passed && !r.sent.length && r.warned.length === 1);
    r = await run(cmd, false, "private");
    ok(`${cmd}: 오너 아닌 DM 도 막는다`, !r.passed && !r.sent.length);
  }
  const r = await run("/status", false, "supergroup");
  ok("다른 명령은 건드리지 않는다", r.passed);
}

report("usage");
