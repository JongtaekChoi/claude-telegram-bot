// codex exec 의 `-o` 출력(codex-last-message-<pid>.txt)은 지우는 자리가 없어 재시작마다 한 개씩
// 영구히 쌓였다 — 2026-09-04 에 7월치부터 15개가 남아 있었다. 부팅 때 죽은 PID 것만 쓸어담는다.
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const block = cut("function sweepCodexScratch()", "// ── Codex 폴백 실행 ──");

let removed, files, alive, permDenied;

function build() {
  removed = [];
  return new Function(
    "readdirSync", "unlinkSync", "join", "BOT_DIR", "process",
    `${block}\nreturn sweepCodexScratch;`,
  )(
    () => files,
    (p) => { removed.push(p); },
    (...a) => a.join("/"),
    "/data",
    {
      pid: 500,
      kill(pid) {
        if (permDenied.includes(pid)) { const e = new Error("EPERM"); e.code = "EPERM"; throw e; }
        if (!alive.includes(pid)) { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; }
      },
    },
  );
}

// ── 죽은 PID 만 지운다 ───────────────────────────────────────────────────
{
  files = ["codex-last-message-101.txt", "codex-last-message-202.txt"];
  alive = [202]; permDenied = [];
  const n = build()();
  ok("죽은 것 1개 지움", n === 1, String(n));
  ok("죽은 PID 파일만", removed.join() === "/data/codex-last-message-101.txt", removed.join());
  ok("살아 있는 PID 는 남긴다", !removed.some((p) => p.includes("202")));
}

// ── 자기 자신은 절대 안 지운다 (지금 쓰는 중) ────────────────────────────
{
  files = ["codex-last-message-500.txt"];
  alive = []; permDenied = [];
  const n = build()();
  ok("내 PID 파일은 남긴다", n === 0 && removed.length === 0, removed.join());
}

// ── EPERM 은 '살아 있음'이다 — 남의 사용자가 띄운 봇 ─────────────────────
{
  files = ["codex-last-message-303.txt"];
  alive = []; permDenied = [303];
  const n = build()();
  ok("EPERM 은 안 지운다", n === 0 && removed.length === 0, removed.join());
}

// ── 다른 파일은 건드리지 않는다 ──────────────────────────────────────────
{
  files = [
    "state.json", "local.lock", "memory.md", "codex-handoff.md",
    "config.json.bak-20260819-153117", "codex-last-message-.txt",
    "codex-last-message-abc.txt", "codex-last-message-101.txt.bak",
    "codex-last-message-101.txt",
  ];
  alive = []; permDenied = [];
  const n = build()();
  ok("이름이 정확히 맞는 것만", n === 1, String(n));
  ok("state.json 은 안 건드림", !removed.some((p) => p.includes("state.json")));
  ok("local.lock 은 안 건드림", !removed.some((p) => p.includes("local.lock")));
  ok("숫자 아닌 pid 는 안 건드림", !removed.some((p) => p.includes("abc")));
  ok(".bak 꼬리표는 안 건드림", !removed.some((p) => p.endsWith(".bak")));
}

// ── 지우다 실패해도 나머지를 계속 돈다 ───────────────────────────────────
{
  files = ["codex-last-message-101.txt", "codex-last-message-102.txt", "codex-last-message-103.txt"];
  alive = []; permDenied = [];
  removed = [];
  const fn = new Function(
    "readdirSync", "unlinkSync", "join", "BOT_DIR", "process",
    `${block}\nreturn sweepCodexScratch;`,
  )(
    () => files,
    (p) => { if (p.includes("102")) throw new Error("EACCES"); removed.push(p); },
    (...a) => a.join("/"),
    "/data",
    { pid: 500, kill() { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; } },
  );
  const n = fn();
  ok("실패한 건 세지 않는다", n === 2, String(n));
  ok("실패 뒤에도 계속 돈다", removed.some((p) => p.includes("103")), removed.join());
}

// ── 빈 폴더 ──────────────────────────────────────────────────────────────
{
  files = []; alive = []; permDenied = [];
  const n = build()();
  ok("지울 게 없으면 0", n === 0, String(n));
}

report();
