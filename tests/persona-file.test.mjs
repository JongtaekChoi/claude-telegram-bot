// 채팅에서 만든 역할은 `.claude-bot/personas/<id>.md` 에 산다. 봇은 config.json 을 쓰지 않는다 —
// 부팅 JSON.parse 에 보호가 없어 config 가 깨지면 크래시 루프에 빠지고 복구 수단이 SSH 뿐인데,
// 원격 관리를 하려고 만든 기능이 실패할 때 SSH 를 강제하면 없느니만 못하다.
// → docs/design/room-personas.md "페르소나를 채팅에서 만든다"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cut } from "./helpers/extract.mjs";
import { ok, eq, report } from "./helpers/assert.mjs";

const block = cut("const PERSONA_DIR = join(BOT_DIR,", "\n// 사람은 한 생각을 여러 메시지로");

let warned;
function build(cfg, dir) {
  warned = [];
  return new Function(
    "cfg", "join", "BOT_DIR", "PERSONA_ID_RE", "readdirSync", "readFileSync", "console",
    `${block}\nreturn { buildPersonas, personaFiles, parsePersonaFile, reloadPersonas };`,
  )(
    cfg, join, dir, /^[a-z0-9][a-z0-9-]*$/i, readdirSync, readFileSync,
    { error: (m) => warned.push(m), warn: (m) => warned.push(m) },
  );
}

const root = mkdtempSync(join(tmpdir(), "ctb-personas-"));
const pdir = join(root, "personas");
mkdirSync(pdir);
writeFileSync(join(pdir, "scroll.md"), "스크롤스티치\n너는 Scroll Stitch 를 맡는다.\n");
writeFileSync(join(pdir, "hanja.md"), "한자도사\n너는 한자도사를 맡는다.\n");
writeFileSync(join(pdir, "noname.md"), "\n이름 줄이 비었다.\n");
writeFileSync(join(pdir, "empty.md"), "이름만 있고 본문이 없다\n");
writeFileSync(join(pdir, "Bad Id.md"), "나쁜 아이디\n본문\n");
writeFileSync(join(pdir, "notes.txt"), "마크다운이 아니다\n본문\n");

// ── 파일 읽기 ────────────────────────────────────────────────────────────
{
  const a = build({}, root);
  const got = a.personaFiles();
  eq("md 만, 유효한 것만", got.map((p) => p.id).join(), "hanja,noname,scroll");
  eq("첫 줄이 이름", got.find((p) => p.id === "scroll").name, "스크롤스티치");
  eq("나머지가 프롬프트", got.find((p) => p.id === "scroll").prompt, "너는 Scroll Stitch 를 맡는다.");
  eq("이름 줄이 비면 id 를 이름으로", got.find((p) => p.id === "noname").name, "noname");
  ok("본문이 없으면 뺀다", !got.some((p) => p.id === "empty"));
  ok("왜 뺐는지 로그에 남긴다", warned.some((m) => m.includes("empty")), JSON.stringify(warned));
  ok("id 규칙을 어기면 뺀다", !got.some((p) => p.id.includes(" ")));
  ok(".txt 는 안 읽는다", !got.some((p) => p.id === "notes"));
}
{
  const a = build({}, join(root, "없는폴더"));
  eq("폴더가 없으면 조용히 빈 목록", a.personaFiles().length, 0);
  eq("그건 오류가 아니다", warned.length, 0);
}

// ── config 와의 합집합 ───────────────────────────────────────────────────
{
  const a = build({ personas: [{ id: "dev", name: "개발", prompt: "x", dir: "repo" }] }, root);
  const got = a.buildPersonas();
  eq("config 가 먼저, 그다음 파일", got.map((p) => p.id).join(), "dev,hanja,noname,scroll");
  ok("config 출신에는 fromFile 이 없다", !got.find((p) => p.id === "dev").fromFile);
  ok("파일 출신은 fromFile", got.find((p) => p.id === "scroll").fromFile === true);
  eq("config 의 dir 은 그대로", got.find((p) => p.id === "dev").dir, "repo");
}
{
  // id 가 겹치면 config 가 이긴다 — 봇이 사람이 쓴 정의를 덮으면 손으로 고칠 길이 없어진다.
  const a = build({ personas: [{ id: "scroll", name: "config 쪽", prompt: "config 본문" }] }, root);
  const got = a.buildPersonas();
  eq("겹치면 config", got.find((p) => p.id === "scroll").name, "config 쪽");
  eq("파일은 하나만 밀린다", got.filter((p) => p.id === "scroll").length, 1);
  ok("무시했다고 로그에 남긴다", warned.some((m) => m.includes("config wins")), JSON.stringify(warned));
  ok("밀린 쪽은 fromFile 이 아니다", !got.find((p) => p.id === "scroll").fromFile);
}
{
  const a = build({}, join(root, "없는폴더"));
  eq("config 도 파일도 없으면 빈 목록", a.buildPersonas().length, 0);
}
{
  // 역할을 안 쓰는 봇은 값이 예전과 완전히 같아야 한다.
  const a = build({ personas: "배열이 아님" }, join(root, "없는폴더"));
  eq("망가진 config 는 무시", a.buildPersonas().length, 0);
  ok("이유는 남긴다", warned.some((m) => m.includes("must be an array")));
}

// ── 다시 읽기 (재시작 없이) ──────────────────────────────────────────────
{
  const a = build({}, root);
  eq("처음", a.buildPersonas().length, 3);
  writeFileSync(join(pdir, "ledger.md"), "가계부\n너는 가계부를 맡는다.\n");
  eq("새로 쓴 파일이 바로 보인다", a.reloadPersonas().length, 4);
}

report();
