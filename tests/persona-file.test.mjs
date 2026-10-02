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


// ── 입력 받기 (add/edit/rm) ──────────────────────────────────────────────
// 처음엔 한 메시지(첫 줄 id·둘째 줄 이름·나머지 본문)만 받았는데, 텔레그램 모바일은 엔터가 곧
// 전송이라 첫 줄만 날아가서 사용법만 되돌아왔다(2026-10-02). 두 단계로도 받는다.
{
  const editBlock = cut("const PERSONA_PROMPT_MAX =", "\nasync function handlePersonaSet");
  const { mkdtempSync, existsSync } = await import("node:fs");
  const dir = join(mkdtempSync(join(tmpdir(), "pe-")), "personas");
  let sent, personas;
  const api = (list = []) => {
    sent = []; personas = list;
    return new Function(
      "PERSONA_DIR", "PERSONA_ID_RE", "PERSONAS", "state", "send", "t", "reloadPersonas",
      "mkdirSync", "writeFileSync", "unlinkSync", "join", "Date",
      `${editBlock}\nreturn { handlePersonaEdit, pendingPersona };`,
    )(
      dir, /^[a-z0-9][a-z0-9-]*$/i, personas, { sessions: {} },
      async (c, text) => { sent.push(text); }, (l, k, ...a) => `${k}(${a.join("|")})`,
      () => personas, mkdirSync, writeFileSync, (f) => { throw new Error("no rm in test"); }, join, Date,
    );
  };

  // 한 메시지로 끝내기 — 첫 줄에 id 와 이름, 다음 줄부터 본문
  const a = api();
  await a.handlePersonaEdit("688", "add", "one-shot 한방\n본문입니다\n두 줄짜리", "ko");
  ok("한 메시지: 바로 쓴다", sent[0].startsWith("personaAdded(한방|one-shot"), sent[0]);
  ok("파일이 생긴다", existsSync(join(dir, "one-shot.md")));

  // 두 단계 — id 와 이름만 보내고 본문은 다음 메시지로
  const b = api();
  await b.handlePersonaEdit("688", "add", "two-step 두단계", "ko");
  ok("본문이 없으면 기다린다", sent[0].startsWith("personaAwaitBody(두단계|two-step"), sent[0]);
  ok("아직 안 쓴다", !existsSync(join(dir, "two-step.md")));
  eq("기다리는 중", b.pendingPersona.size, 1);
  await b.handlePersonaEdit("688", "add", "two-step 두단계\n나중에 온 본문", "ko");
  ok("다음 메시지로 완성된다", sent[1].startsWith("personaAdded(두단계|two-step"), sent[1]);

  // 이름을 아예 안 주면 id 를 이름으로 — 이름 하나 때문에 되묻는 건 과하다
  // 이름 없이 id + 본문 — 가장 자연스러운 입력이다. 예전엔 본문 첫 줄이 이름으로 먹혀서
  // 본문이 비고 사용법만 되돌아갔다.
  const c = api();
  await c.handlePersonaEdit("688", "add", "no-name\n본문만 있다", "ko");
  ok("이름이 없으면 id 를 쓰고 본문은 그대로", sent[0].startsWith("personaAdded(no-name|no-name"), sent[0]);

  // id 규칙 — 왜 안 되는지 말한다. 사용법만 되돌리면 같은 걸 또 보낸다.
  const d = api();
  await d.handlePersonaEdit("688", "add", "scroll_dev 밑줄\n본문", "ko");
  ok("밑줄 id 는 이유를 말한다", sent[0] === "personaBadId(scroll_dev)", sent[0]);
  await d.handlePersonaEdit("688", "add", "한글아이디 이름\n본문", "ko");
  ok("한글 id 도 이유를 말한다", sent[1].startsWith("personaBadId("), sent[1]);
  await d.handlePersonaEdit("688", "add", "", "ko");
  ok("아무것도 없으면 사용법", sent[2] === "personaAddUsage()", sent[2]);

  // config 출신은 채팅에서 못 고친다
  const e = api([{ id: "cfg-one", name: "설정", prompt: "x" }]);
  await e.handlePersonaEdit("688", "edit", "cfg-one 새 이름\n새 본문", "ko");
  ok("config 출신은 거절", sent[0] === "personaFromConfig(cfg-one)", sent[0]);

  // 있는 id 로 add, 없는 id 로 edit
  const f = api([{ id: "mine", name: "내것", prompt: "x", fromFile: true }]);
  await f.handlePersonaEdit("688", "add", "mine 이름\n본문", "ko");
  ok("이미 있으면 add 거절", sent[0] === "personaExists(mine)", sent[0]);
  await f.handlePersonaEdit("688", "edit", "nope 이름\n본문", "ko");
  ok("없으면 edit 거절", sent[1] === "personaNoSuch(nope)", sent[1]);

  // 취소
  const g = api();
  await g.handlePersonaEdit("688", "add", "will-cancel 취소할것", "ko");
  await g.handlePersonaEdit("688", "cancel", "", "ko");
  ok("취소하면 기다리기를 멈춘다", sent[1] === "personaCanceled()" && g.pendingPersona.size === 0, sent[1]);
  await g.handlePersonaEdit("688", "cancel", "", "ko");
  ok("기다리는 게 없으면 그렇다고 한다", sent[2] === "personaNoPending()", sent[2]);

  // 너무 긴 프롬프트 — 매 턴 시스템 프롬프트에 통째로 실린다
  const h = api();
  await h.handlePersonaEdit("688", "add", `too-long 길다\n${"가".repeat(8001)}`, "ko");
  ok("8000자 넘으면 거절", sent[0].startsWith("personaTooLong("), sent[0]);
}

report();
