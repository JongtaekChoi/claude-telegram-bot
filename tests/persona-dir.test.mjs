// personas[].dir — 한 봇이 방마다 다른 폴더에서 돈다. 폴더가 갈리면 그 폴더의 CLAUDE.md 가
// 따라오고 /sessions 도 저절로 갈린다.
// 제일 조용히 깨지는 자리는 /sessions 다 — 전역 cfg.projectDir 로 거르면 dir 을 가진 방이
// 자기 세션은 하나도 못 찾고 **남의 것만** 보여준다. 에러도 빈 목록도 아니라서 안 드러난다.
// → docs/design/room-personas.md
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const dirBlock = cut("const personaDirOf =", "\nfunction loadMemory");
const missBlock = cut("const missingRoomDir =", "\n// ── Claude 실행");
const sessBlock = cut("function claudeSessionDir(dir)", "\nfunction claudeSessions");

const PROJ = "/proj";

function build({ personas = [], sessions = {}, projectDir = PROJ, noProject = false, dataDir = "/data", exists = () => true } = {}) {
  if (noProject) projectDir = undefined;
  const state = { sessions };
  return new Function(
    "cfg", "DATA_DIR", "PERSONAS", "state", "resolve", "join", "OUTBOX_NAME", "existsSync", "roomPersona",
    `${dirBlock}\n${missBlock}\nreturn { personaDirOf, roomDir, roomBase, outboxDir, workDirs, missingRoomDir };`,
  )(
    { projectDir }, dataDir, personas, state,
    resolve,
    (...p) => p.join("/").replace(/\/+/g, "/"),
    ".ctb-outbox",
    exists,
    (chatId) => {
      if (!personas.length) return null;
      const id = chatId == null ? null : state.sessions?.[String(chatId)]?.persona;
      return (id && personas.find((p) => p.id === id)) || personas[0];
    },
  );
}

const P = [
  { id: "planner", name: "기획자" },                       // dir 없음
  { id: "dev", name: "개발자", dir: "../other-repo" },       // 상대경로
  { id: "ops", name: "관리자", dir: "/abs/ops" },            // 절대경로
];
const S = { "1": { persona: "planner" }, "2": { persona: "dev" }, "3": { persona: "ops" }, "4": {} };

// ── 폴더 해석 ────────────────────────────────────────────────────────────
{
  const a = build({ personas: P, sessions: S });
  ok("dir 없는 역할 → cfg.projectDir 그대로", a.roomDir("1") === PROJ, a.roomDir("1"));
  ok("상대 dir → projectDir 기준으로 푼다", a.roomDir("2") === "/other-repo", a.roomDir("2"));
  ok("절대 dir → 그대로", a.roomDir("3") === "/abs/ops", a.roomDir("3"));
  ok("역할 미지정 방 → PERSONAS[0]", a.roomDir("4") === PROJ, a.roomDir("4"));
  ok("모르는 방 → PERSONAS[0]", a.roomDir("999") === PROJ);
}
{
  // 페르소나를 안 쓰면 값이 예전과 완전히 같아야 한다 — 이게 이 기능의 전제다
  const a = build({ personas: [], sessions: {} });
  ok("페르소나 없음 → projectDir", a.roomDir("1") === PROJ);
  ok("페르소나 없음 → workDirs 는 한 개", a.workDirs().length === 1 && a.workDirs()[0] === PROJ);
}
{
  const a = build({ personas: [{ id: "x" }], noProject: true, dataDir: "/data" });
  ok("projectDir 없으면 roomDir 은 undefined (cwd 상속)", a.roomDir("1") === undefined);
  ok("합성하는 자리는 DATA_DIR 로 내려온다", a.roomBase("1") === "/data");
  ok("아웃박스도 DATA_DIR 아래", a.outboxDir("1") === "/data/.ctb-outbox");
}
{
  const a = build({ personas: P, sessions: S });
  ok("아웃박스는 방 폴더 아래", a.outboxDir("2") === "/other-repo/.ctb-outbox", a.outboxDir("2"));
  ok("아웃박스: 방마다 다르다", a.outboxDir("1") !== a.outboxDir("3"));
}

// ── workDirs — 부팅 mkdir·작업 감시가 전부 훑어야 한다 ───────────────────
{
  const a = build({ personas: P, sessions: S });
  const w = a.workDirs();
  ok("workDirs: 폴더 셋을 다 훑는다", w.length === 3, JSON.stringify(w));
  ok("workDirs: projectDir 이 먼저", w[0] === PROJ, JSON.stringify(w));
  ok("workDirs: 상대·절대 둘 다 포함", w.includes("/other-repo") && w.includes("/abs/ops"), JSON.stringify(w));
}
{
  // 같은 폴더를 가리키는 역할이 둘이면 한 번만
  const a = build({ personas: [{ id: "a", dir: "sub" }, { id: "b", dir: "sub" }, { id: "c" }] });
  const w = a.workDirs();
  ok("workDirs: 중복 폴더는 한 번만", w.length === 2, JSON.stringify(w));
}

// ── 없는 폴더 ────────────────────────────────────────────────────────────
{
  const a = build({ personas: P, sessions: S, exists: (d) => d !== "/abs/ops" });
  ok("없는 dir 은 이름을 대며 잡힌다", a.missingRoomDir("3") === "/abs/ops", String(a.missingRoomDir("3")));
  ok("있는 dir 은 통과", a.missingRoomDir("2") === null);
}
{
  const a = build({ personas: [{ id: "x" }], noProject: true, exists: () => false });
  ok("projectDir 자체가 없으면 검사 안 한다 (cwd 상속)", a.missingRoomDir("1") === null);
}

// ── /sessions 가 방 폴더를 따라가는가 (실제 파일로) ──────────────────────
// 여기가 조용히 깨지는 자리라 스텁이 아니라 진짜 폴더를 만들어 확인한다.
const TMP = join(tmpdir(), `ctb-persona-dir-${process.pid}`);
const HOME = join(TMP, "home");
const PROJECTS = join(HOME, ".claude", "projects");
const slug = (d) => d.replace(/[^a-zA-Z0-9]/g, "-");

try {
  // 방 A: 슬러그 규칙대로 폴더 이름이 맞는 경우
  const dirA = join(TMP, "repo-a");
  const slugA = join(PROJECTS, slug(dirA));
  mkdirSync(slugA, { recursive: true });
  writeFileSync(join(slugA, "aaa.jsonl"), "{}\n");

  // 방 B: 폴더 이름이 어긋나 cwd 로만 되짚을 수 있는 경우 (규칙은 비공식이라 바뀔 수 있다)
  const dirB = join(TMP, "repo-b");
  const oddB = join(PROJECTS, "some-renamed-folder");
  mkdirSync(oddB, { recursive: true });
  writeFileSync(join(oddB, "bbb.jsonl"), `{"cwd":"${dirB}"}\n`);

  const findDir = new Function(
    "join", "resolve", "existsSync", "readdirSync", "readHead", "process",
    `${sessBlock}\nreturn claudeSessionDir;`,
  )(
    (...p) => join(...p),
    (p) => p,
    existsSync,
    readdirSync,
    (path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } },
    { env: { HOME } },
  );

  ok("세션 폴더: 슬러그가 맞으면 그걸 쓴다", findDir(dirA) === slugA, String(findDir(dirA)));
  ok("세션 폴더: 슬러그가 어긋나도 cwd 로 되짚는다", findDir(dirB) === oddB, String(findDir(dirB)));
  ok("세션 폴더: 어느 쪽으로도 못 찾으면 null", findDir(join(TMP, "nope")) === null, String(findDir(join(TMP, "nope"))));
  ok("세션 폴더: 방마다 다른 폴더가 나온다", findDir(dirA) !== findDir(dirB));
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}

report();
